// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 Wojciech Polak

import { createHmac, randomBytes } from 'node:crypto';
import type { CookieSerializeOptions } from '@fastify/cookie';
import {
    createBrowserSsoBootstrapReceipt,
    isBrowserSsoDocumentNavigation,
    safeCompare,
} from '@magic-link-sso/config-core/runtime';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { z } from 'zod';
import type { AppConfig, SiteConfig } from './config.js';
import { generateEmailToken, signAccessToken, verifyEmailToken } from './auth.js';
import type { VerificationEmailSender } from './email.js';
import type { SharedSecurityState } from './securityState.js';
import type { OtpChallengeStore } from './otpChallengeStore.js';
import type { PerEmailSignInLimiter } from './perEmailSignInLimiter.js';
import type { VerificationTokenReplayStore } from './verificationTokenReplayStore.js';
import {
    createBrowserSsoOpaqueValue,
    hashBrowserSsoValue,
    type StoredAuthorizationRequest,
} from './browserSsoStore.js';
import { bootstrapContextSchema, browserSsoBootstrapEnabled } from './browserSsoBootstrap.js';
import { generateOtpCode, hashOtpCode, normaliseOtpCode } from './otp.js';
import { normalizeRequestedScope } from './scope.js';

const opaque = z.string().regex(/^[A-Za-z0-9_-]{43}$/);
const authorizeSchema = z
    .object({
        redirectUri: z.string().url().max(2048),
        state: opaque,
        codeChallenge: opaque,
        codeChallengeMethod: z.literal('S256'),
        scope: z
            .string()
            .refine((value) => Buffer.byteLength(value, 'utf8') <= 256)
            .optional(),
        prompt: z.literal('login').optional(),
        loginUi: z.enum(['hosted', 'app-owned']).optional(),
    })
    .strict();
const requestSchema = z.object({ requestId: opaque });
const signInSchema = requestSchema.extend({
    email: z.string().trim().toLowerCase().email().max(254),
});
const proofSchema = requestSchema.extend({ token: z.string().min(1).max(4096) });
const otpSchema = requestSchema.extend({
    challengeId: z.string().uuid(),
    code: z.string().max(64),
    otpContext: opaque,
});
const exchangeSchema = z
    .object({
        code: opaque,
        codeVerifier: z.string().regex(/^[A-Za-z0-9._~-]{43,128}$/),
        redirectUri: z.string().url().max(2048),
    })
    .strict();
const bootstrapRedeemSchema = z
    .object({ ticket: opaque, redirectUri: z.string().url().max(2048), state: opaque })
    .strict();
const bootstrapConfirmationSchema = bootstrapRedeemSchema.extend({ csrfToken: opaque }).strict();

const signOutSchema = z.object({ returnUri: z.string().url().max(2048).optional() });

interface Dependencies {
    config: AppConfig;
    mailer: VerificationEmailSender;
    securityState: SharedSecurityState;
    otpChallengeStore: OtpChallengeStore;
    perEmailSignInLimiter: PerEmailSignInLimiter;
    verificationTokenReplayStore: VerificationTokenReplayStore;
    siteAllows(site: SiteConfig, email: string, scope: string): boolean;
}

const messages = {
    invalid_request: 'This sign-in request is invalid. Start sign-in again from your application.',
    invalid_callback: 'This application has no matching browser SSO registration.',
    access_denied:
        'This account does not have access to the application. You can sign in with a different account.',
    request_expired: 'This sign-in request has expired. Start sign-in again from your application.',
    code_rejected:
        'The authorization code is invalid or has already been used. Start sign-in again.',
    session_expired:
        'The browser SSO session has ended. Start sign-in again from your application.',
    sso_disabled: 'Browser SSO is disabled. Contact the application administrator.',
    temporarily_unavailable:
        'Magic Link SSO is temporarily unavailable. Try starting sign-in again.',
};
type ErrorCode = keyof typeof messages;

function readField(value: unknown, field: string): string | undefined {
    if (typeof value !== 'object' || value === null) {
        return undefined;
    }
    const result: unknown = Reflect.get(value, field);
    return typeof result === 'string' ? result : undefined;
}

/** Hosted routes are isolated from legacy email grants and app cookie settings. */
export async function registerBrowserSsoRoutes(
    app: FastifyInstance,
    dependencies: Dependencies,
): Promise<void> {
    const { config, securityState, siteAllows } = dependencies;
    const issuer = new URL(config.appUrl).origin;
    const secure = issuer.startsWith('https:');
    const cookiePrefix = secure ? '__Host-' : '';
    const sessionCookie = `${cookiePrefix}magic-sso-browser`;
    const bindingCookie = `${cookiePrefix}magic-sso-browser-binding`;
    const cookieOptions: CookieSerializeOptions = {
        httpOnly: true,
        secure,
        sameSite: 'lax',
        path: '/',
    };
    const store = securityState.browserSsoStore;

    await app.register(
        async (sso): Promise<void> => {
            sso.addHook('onRequest', async (_request, reply): Promise<void> => {
                reply
                    .header('Cache-Control', 'no-store')
                    .header('Pragma', 'no-cache')
                    .header('Referrer-Policy', 'no-referrer');
            });

            function csrf(binding: string): string {
                return createHmac('sha256', config.csrfSecret)
                    .update(`magic-link-sso/browser-sso/csrf\n${binding}`)
                    .digest('base64url');
            }
            function otpContext(requestId: string, challengeId: string): string {
                return createHmac('sha256', config.csrfSecret)
                    .update(`magic-link-sso/browser-sso/otp\n${requestId}\n${challengeId}`)
                    .digest('base64url');
            }
            function currentBinding(request: FastifyRequest): string | undefined {
                const value = request.cookies[bindingCookie];
                return opaque.safeParse(value).success ? value : undefined;
            }
            function ensureBinding(request: FastifyRequest, reply: FastifyReply): string {
                const value = currentBinding(request) ?? createBrowserSsoOpaqueValue();
                request.cookies[bindingCookie] = value;
                reply.setCookie(bindingCookie, value, {
                    ...cookieOptions,
                    maxAge: (config.browserSso?.requestLifetimeSeconds ?? 900) + 150,
                });
                return value;
            }
            function validMutation(request: FastifyRequest): boolean {
                const binding = currentBinding(request);
                const submitted = readField(request.body, 'csrfToken');
                // no-referrer can serialize a same-origin form's Origin as null.
                // Only browser-controlled same-origin Fetch Metadata can replace
                // the origin check, and the binding-derived CSRF proof is still required.
                const origin = request.headers.origin;
                const sameOrigin =
                    origin === issuer ||
                    ((origin === undefined || origin === 'null') &&
                        request.headers['sec-fetch-site'] === 'same-origin');
                return (
                    sameOrigin &&
                    binding !== undefined &&
                    submitted !== undefined &&
                    safeCompare(submitted, csrf(binding))
                );
            }
            function registration(
                redirectUri: string,
            ): { site: SiteConfig; startUri: string } | undefined {
                for (const site of config.sites) {
                    const entry = site.sso?.find(
                        (candidate) => candidate.redirectUri === redirectUri,
                    );
                    if (entry) {
                        return { site, startUri: entry.startUri };
                    }
                }
                return undefined;
            }
            async function view(
                reply: FastifyReply,
                template: string,
                site: SiteConfig | undefined,
                fields: Record<string, unknown>,
                status = 200,
            ): Promise<void> {
                const nonce = randomBytes(16).toString('base64url');
                // Browsers also apply form-action to the redirect chain after
                // confirmation. Allow only registered app origins for its 303.
                const formOrigins = [
                    ...new Set(site?.sso?.map((entry) => new URL(entry.redirectUri).origin) ?? []),
                ];
                reply.header(
                    'Content-Security-Policy',
                    [
                        "default-src 'self'",
                        "base-uri 'none'",
                        ["form-action 'self'", ...formOrigins].join(' '),
                        "frame-ancestors 'none'",
                        "object-src 'none'",
                        "img-src 'self' data: https: http:",
                        `script-src 'nonce-${nonce}'`,
                        `style-src 'nonce-${nonce}'`,
                    ].join('; '),
                );
                await reply.code(status).view(template, {
                    branding: site?.hostedAuthBranding ?? config.hostedAuthBranding,
                    lang: site?.hostedAuthPageCopy.lang ?? config.hostedAuthPageCopy.lang,
                    cspNonce: nonce,
                    csrfToken: null,
                    email: null,
                    error: false,
                    copy:
                        site?.hostedAuthPageCopy.verifyEmail ??
                        config.hostedAuthPageCopy.verifyEmail,
                    ...fields,
                });
            }
            async function fail(
                request: FastifyRequest,
                reply: FastifyReply,
                error: ErrorCode,
                status: number,
                nextHref?: string,
            ): Promise<void> {
                if (request.headers.accept?.includes('text/html')) {
                    await view(
                        reply,
                        'verify-email.ejs',
                        undefined,
                        {
                            error: messages[error],
                            nextHref,
                            nextText: 'Sign in with a different account',
                        },
                        status,
                    );
                } else {
                    reply.code(status).send({ error, message: messages[error] });
                }
            }
            sso.setErrorHandler(async (error, request, reply): Promise<void> => {
                const status =
                    typeof error === 'object' && error !== null
                        ? Reflect.get(error, 'statusCode')
                        : undefined;
                if (typeof status === 'number' && status >= 400 && status < 500) {
                    await fail(request, reply, 'invalid_request', status);
                    return;
                }
                // Dependency errors can contain URLs or proof values; log no payload.
                request.log.error(
                    { operation: request.routeOptions.url },
                    'Browser SSO dependency failed',
                );
                await fail(request, reply, 'temporarily_unavailable', 503);
            });
            sso.get('/sso/capabilities', async (_request, reply): Promise<void> => {
                const policy = config.browserSso;
                reply.send({
                    browserSso: policy?.enabled
                        ? {
                              version: 1,
                              enabled: true,
                              loginUi: 'hosted',
                              ...(browserSsoBootstrapEnabled(config)
                                  ? { appOwnedBootstrapVersion: 1 }
                                  : {}),
                              codeChallengeMethods: ['S256'],
                              requestLifetimeSeconds: policy.requestLifetimeSeconds,
                              codeLifetimeSeconds: policy.codeLifetimeSeconds,
                              transactionLifetimeSeconds:
                                  policy.requestLifetimeSeconds + policy.codeLifetimeSeconds + 30,
                          }
                        : { version: 1, enabled: false },
                });
            });
            const policy = config.browserSso;
            if (!policy?.enabled) {
                for (const url of [
                    '/sso/authorize',
                    '/sso/signin',
                    '/sso/verify',
                    '/sso/otp',
                    '/sso/exchange',
                    '/sso/signout',
                    '/sso/bootstrap/inspect',
                    '/sso/bootstrap/redeem',
                ]) {
                    sso.route({
                        method: ['GET', 'POST'],
                        url,
                        handler: async (request, reply): Promise<void> => {
                            await fail(request, reply, 'sso_disabled', 409);
                        },
                    });
                }
                return;
            }
            const pageLimit = {
                config: {
                    rateLimit: {
                        max: config.signInPageRateLimitMax,
                        timeWindow: config.rateLimitWindowMs,
                    },
                },
            };
            const mutationLimit = {
                config: {
                    rateLimit: {
                        max: config.signInRateLimitMax,
                        timeWindow: config.rateLimitWindowMs,
                    },
                },
            };
            const verificationLimit = {
                config: {
                    rateLimit: {
                        max: config.verifyRateLimitMax,
                        timeWindow: config.rateLimitWindowMs,
                    },
                },
            };

            async function boundRequest(
                request: FastifyRequest,
                reply: FastifyReply,
                requestId: string,
            ): Promise<StoredAuthorizationRequest | null> {
                const binding = currentBinding(request);
                const pending = await store.getRequest(requestId, Date.now());
                if (!binding || !pending || pending.bindingHash !== hashBrowserSsoValue(binding)) {
                    await fail(request, reply, 'request_expired', 400);
                    return null;
                }
                return pending;
            }
            async function signinView(
                request: FastifyRequest,
                reply: FastifyReply,
                requestId: string,
                pending: StoredAuthorizationRequest,
                challengeId?: string,
                error: string | false = false,
                status = 200,
            ): Promise<void> {
                const target = registration(pending.redirectUri);
                const binding = currentBinding(request) ?? ensureBinding(request, reply);
                await view(
                    reply,
                    'signin.ejs',
                    target?.site,
                    {
                        copy:
                            target?.site.hostedAuthPageCopy.signin ??
                            config.hostedAuthPageCopy.signin,
                        mode: challengeId === undefined ? 'form' : 'confirmation',
                        csrfToken: csrf(binding),
                        returnUrl: '',
                        verifyUrl: '',
                        scope: '',
                        useDifferentEmailHref: `/sso/signin?${new URLSearchParams({ requestId })}`,
                        otpChallengeId:
                            policy?.enabled && config.otp.enabled ? challengeId : undefined,
                        otpLength: config.otp.length,
                        message: false,
                        error,
                        browserSso: {
                            requestId,
                            otpContext:
                                challengeId === undefined ? '' : otpContext(requestId, challengeId),
                        },
                    },
                    status,
                );
            }
            async function issue(
                request: FastifyRequest,
                reply: FastifyReply,
                input: {
                    requestId: string;
                    sessionHandle: string;
                    grantId?: string;
                },
            ): Promise<void> {
                const binding = currentBinding(request);
                if (!binding) {
                    await fail(request, reply, 'invalid_request', 400);
                    return;
                }
                const result = await store.issueCode({
                    ...input,
                    browserBinding: binding,
                    now: Date.now(),
                    lifetimeSeconds: policy?.codeLifetimeSeconds ?? 60,
                });
                if (result.kind !== 'issued') {
                    await fail(
                        request,
                        reply,
                        result.kind === 'session_expired' ? 'session_expired' : 'request_expired',
                        result.kind === 'session_expired' ? 401 : 400,
                    );
                    return;
                }
                const session = await store.getSession(input.sessionHandle, Date.now());
                const target = registration(result.request.redirectUri);
                if (!session) {
                    await fail(request, reply, 'session_expired', 401);
                    return;
                }
                if (!target || !siteAllows(target.site, session.email, result.request.scope)) {
                    const switchUrl = new URL('/sso/authorize', issuer);
                    switchUrl.search = new URLSearchParams({
                        redirectUri: result.request.redirectUri,
                        state: result.request.state,
                        codeChallenge: result.request.codeChallenge,
                        codeChallengeMethod: 'S256',
                        scope: result.request.scope,
                        prompt: 'login',
                    }).toString();
                    await fail(request, reply, 'access_denied', 403, switchUrl.href);
                    return;
                }
                const callback = new URL(result.request.redirectUri);
                callback.searchParams.set('state', result.request.state);
                callback.searchParams.set('code', result.code);
                reply.code(request.method === 'POST' ? 303 : 302).redirect(callback.href);
            }
            function documentNavigation(request: FastifyRequest): boolean {
                return isBrowserSsoDocumentNavigation({
                    get: (name): string | null => {
                        const value = request.headers[name];
                        return typeof value === 'string' ? value : null;
                    },
                });
            }
            function accountSwitchUrl(
                fieldsInput: z.infer<typeof authorizeSchema>,
                scope: string,
            ): string {
                const switchUrl = new URL('/sso/authorize', issuer);
                const { loginUi, ...fields } = fieldsInput;
                switchUrl.search = new URLSearchParams({
                    ...fields,
                    ...(loginUi === undefined ? {} : { loginUi }),
                    scope,
                    prompt: 'login',
                }).toString();
                return switchUrl.href;
            }
            sso.get('/sso/authorize', pageLimit, async (request, reply): Promise<void> => {
                if (!documentNavigation(request)) {
                    await fail(request, reply, 'invalid_request', 400);
                    return;
                }

                const parsed = authorizeSchema.safeParse(request.query);
                if (!parsed.success) {
                    await fail(request, reply, 'invalid_request', 400);
                    return;
                }
                if (parsed.data.loginUi === 'app-owned' && !browserSsoBootstrapEnabled(config)) {
                    await fail(request, reply, 'sso_disabled', 409);
                    return;
                }
                let target = registration(parsed.data.redirectUri);
                if (!target) {
                    await fail(request, reply, 'invalid_callback', 400);
                    return;
                }
                const sessionHandle = request.cookies[sessionCookie];
                const session =
                    sessionHandle === undefined
                        ? null
                        : await store.getSession(sessionHandle, Date.now());
                target = registration(parsed.data.redirectUri);
                if (!target) {
                    await fail(request, reply, 'invalid_callback', 400);
                    return;
                }
                const scope = normalizeRequestedScope(parsed.data.scope);
                if (
                    session &&
                    parsed.data.prompt !== 'login' &&
                    !siteAllows(target.site, session.email, scope)
                ) {
                    await fail(
                        request,
                        reply,
                        'access_denied',
                        403,
                        accountSwitchUrl(parsed.data, scope),
                    );
                    return;
                }
                const now = Date.now();
                const created = await store.createRequest({
                    ...(parsed.data.loginUi === 'app-owned' ? { flow: 'app-owned' } : {}),
                    browserBinding: ensureBinding(request, reply),
                    siteId: target.site.id,
                    redirectUri: parsed.data.redirectUri,
                    state: parsed.data.state,
                    codeChallenge: parsed.data.codeChallenge,
                    scope,
                    now,
                    expiresAt: now + (policy?.requestLifetimeSeconds ?? 900) * 1000,
                });
                if (created.kind !== 'created') {
                    await fail(request, reply, 'invalid_request', 429);
                    return;
                }
                if (session && sessionHandle && parsed.data.prompt !== 'login') {
                    await issue(request, reply, { requestId: created.requestId, sessionHandle });
                    return;
                }
                if (parsed.data.loginUi === 'app-owned') {
                    const start = new URL(target.startUri);
                    start.searchParams.set('ssoPrepared', '1');
                    start.searchParams.set('state', created.request.state);
                    start.searchParams.set('requestId', created.requestId);
                    reply.code(302).redirect(start.href);
                    return;
                }
                await signinView(request, reply, created.requestId, created.request);
            });
            sso.post(
                '/sso/bootstrap/inspect',
                verificationLimit,
                async (request, reply): Promise<void> => {
                    if (!browserSsoBootstrapEnabled(config)) {
                        await fail(request, reply, 'sso_disabled', 409);
                        return;
                    }
                    const parsed = bootstrapContextSchema.safeParse(request.body);
                    if (
                        !parsed.success ||
                        !request.headers['content-type']?.startsWith('application/json') ||
                        request.headers.origin !== undefined ||
                        request.headers['sec-fetch-site'] !== undefined
                    ) {
                        await fail(request, reply, 'invalid_request', 400);
                        return;
                    }
                    const target = registration(parsed.data.redirectUri);
                    const pending = target
                        ? await store.inspectBootstrapRequest({
                              ...parsed.data,
                              siteId: target.site.id,
                              now: Date.now(),
                          })
                        : null;
                    if (!pending || !registration(parsed.data.redirectUri)) {
                        await fail(request, reply, 'request_expired', 400);
                        return;
                    }
                    reply.send({
                        requestId: parsed.data.requestId,
                        state: pending.state,
                        scope: pending.scope,
                        expiresAt: pending.expiresAt,
                    });
                },
            );
            async function bootstrapFailure(
                reply: FastifyReply,
                status: number,
                callback?: { redirectUri: string; state: string },
            ): Promise<void> {
                const destination =
                    callback && registration(callback.redirectUri)
                        ? new URL(callback.redirectUri)
                        : null;
                if (destination) {
                    destination.searchParams.set('state', callback?.state ?? '');
                    destination.searchParams.set('browserSso', 'failed');
                }
                await view(
                    reply,
                    'verify-email.ejs',
                    undefined,
                    {
                        error: 'Shared browser sign-in was not completed. Return to your application to use its local session or start again.',
                        ...(destination
                            ? { nextHref: destination.href, nextText: 'Return to application' }
                            : {}),
                    },
                    status,
                );
            }
            async function completeBootstrapReply(
                request: FastifyRequest,
                reply: FastifyReply,
                proof: z.infer<typeof bootstrapRedeemSchema>,
                redeemed: Extract<
                    Awaited<ReturnType<typeof store.redeemBootstrapTicket>>,
                    { kind: 'redeemed' }
                >,
                sameBrowser: boolean,
            ): Promise<void> {
                let target: ReturnType<typeof registration>;
                target = registration(proof.redirectUri);
                if (
                    !target ||
                    !siteAllows(target.site, redeemed.session.email, redeemed.ticket.scope)
                ) {
                    await store.revokeSession(redeemed.handle, Date.now());
                    await bootstrapFailure(reply, 403, proof);
                    return;
                }
                const receipt = sameBrowser
                    ? await createBrowserSsoBootstrapReceipt(config.jwtSecret, {
                          issuer,
                          audience: new URL(redeemed.ticket.redirectUri).origin,
                          redirectUri: redeemed.ticket.redirectUri,
                          state: redeemed.ticket.state,
                          bootstrapTicket: proof.ticket,
                          accessTokenHash: redeemed.ticket.accessTokenHash,
                      })
                    : null;
                target = registration(proof.redirectUri);
                if (
                    !target ||
                    !siteAllows(target.site, redeemed.session.email, redeemed.ticket.scope)
                ) {
                    await store.revokeSession(redeemed.handle, Date.now());
                    await bootstrapFailure(reply, 403, proof);
                    return;
                }
                reply.setCookie(sessionCookie, redeemed.handle, {
                    ...cookieOptions,
                    maxAge: Math.floor((redeemed.session.expiresAt - Date.now()) / 1000),
                });
                if (receipt === null) {
                    await view(reply, 'verify-email.ejs', target.site, {
                        copy: {
                            ...target.site.hostedAuthPageCopy.verifyEmail,
                            title: 'Shared sign-in confirmed',
                            helpText: 'Start a fresh application transaction in this browser.',
                        },
                        email: redeemed.session.email,
                        nextHref: target.startUri,
                        nextText: 'Continue to application',
                    });
                    return;
                }
                const callback = new URL(redeemed.ticket.redirectUri);
                callback.search = new URLSearchParams({
                    state: redeemed.ticket.state,
                    browserSso: 'complete',
                    receipt,
                }).toString();
                reply.code(request.method === 'POST' ? 303 : 302).redirect(callback.href);
            }
            async function redeemBootstrap(
                request: FastifyRequest,
                reply: FastifyReply,
                confirmed: boolean,
            ): Promise<void> {
                if (!browserSsoBootstrapEnabled(config)) {
                    await fail(request, reply, 'sso_disabled', 409);
                    return;
                }
                if (!documentNavigation(request) || (confirmed && !validMutation(request))) {
                    await bootstrapFailure(reply, 403);
                    return;
                }
                const parsed = confirmed
                    ? bootstrapConfirmationSchema.safeParse(request.body)
                    : bootstrapRedeemSchema.safeParse(request.query);
                if (!parsed.success) {
                    await bootstrapFailure(reply, 400);
                    return;
                }
                const ticket = await store.getBootstrapTicket(parsed.data.ticket, Date.now());
                let target = registration(parsed.data.redirectUri);
                if (
                    !ticket ||
                    !target ||
                    ticket.siteId !== target.site.id ||
                    ticket.redirectUri !== parsed.data.redirectUri ||
                    ticket.state !== parsed.data.state
                ) {
                    await bootstrapFailure(reply, 400, parsed.data);
                    return;
                }
                if (!siteAllows(target.site, ticket.email, ticket.scope)) {
                    await bootstrapFailure(reply, 403, parsed.data);
                    return;
                }
                const binding = ensureBinding(request, reply);
                const sameBrowser = ticket.bindingHash === hashBrowserSsoValue(binding);
                const previousHandle = request.cookies[sessionCookie];
                const now = Date.now();
                const redeemed = await store.redeemBootstrapTicket({
                    ticket: parsed.data.ticket,
                    redirectUri: parsed.data.redirectUri,
                    state: parsed.data.state,
                    siteId: target.site.id,
                    browserBinding: binding,
                    confirmedAccountChange: confirmed,
                    now,
                    sessionExpiresAt: now + (policy?.sessionLifetimeSeconds ?? 28_800) * 1000,
                    ...(previousHandle === undefined ? {} : { previousHandle }),
                });
                if (redeemed.kind === 'confirmation_required') {
                    await view(reply, 'verify-email.ejs', target.site, {
                        copy: {
                            ...target.site.hostedAuthPageCopy.verifyEmail,
                            title: 'Complete shared sign-in',
                            helpText:
                                'Confirm this account for browser SSO. Existing application sessions keep their current identity.',
                            continueButton: 'Confirm shared sign-in',
                        },
                        email: ticket.email,
                        csrfToken: csrf(binding),
                        formAction: '/sso/bootstrap/redeem',
                        formFields: {
                            ticket: parsed.data.ticket,
                            redirectUri: parsed.data.redirectUri,
                            state: parsed.data.state,
                        },
                    });
                    return;
                }
                if (redeemed.kind !== 'redeemed') {
                    await bootstrapFailure(reply, 400, parsed.data);
                    return;
                }
                await completeBootstrapReply(request, reply, parsed.data, redeemed, sameBrowser);
            }
            sso.get('/sso/bootstrap/redeem', pageLimit, async (request, reply): Promise<void> => {
                await redeemBootstrap(request, reply, false);
            });
            sso.post(
                '/sso/bootstrap/redeem',
                verificationLimit,
                async (request, reply): Promise<void> => {
                    await redeemBootstrap(request, reply, true);
                },
            );
            sso.get('/sso/signin', pageLimit, async (request, reply): Promise<void> => {
                const parsed = requestSchema.safeParse(request.query);
                if (!parsed.success) {
                    await fail(request, reply, 'invalid_request', 400);
                    return;
                }
                const pending = await boundRequest(request, reply, parsed.data.requestId);
                if (pending) {
                    await signinView(request, reply, parsed.data.requestId, pending);
                }
            });
            sso.post('/sso/signin', mutationLimit, async (request, reply): Promise<void> => {
                const parsed = signInSchema.safeParse(request.body);
                if (!parsed.success || !validMutation(request)) {
                    await fail(request, reply, 'invalid_request', 403);
                    return;
                }
                const { requestId, email } = parsed.data;
                const pending = await boundRequest(request, reply, requestId);
                if (!pending) {
                    return;
                }
                const target = registration(pending.redirectUri);
                if (!target) {
                    await fail(request, reply, 'invalid_callback', 400);
                    return;
                }
                const limit = await dependencies.perEmailSignInLimiter.consume(email, request.ip);
                if (!limit.allowed) {
                    reply.header('Retry-After', limit.retryAfterSeconds);
                    await fail(request, reply, 'invalid_request', 429);
                    return;
                }
                const challengeId = crypto.randomUUID();
                if (!siteAllows(target.site, email, pending.scope)) {
                    await signinView(request, reply, requestId, pending, challengeId);
                    return;
                }
                const lifetime = Math.min(
                    config.emailExpirationSeconds,
                    Math.floor((pending.expiresAt - Date.now()) / 1000),
                );
                if (lifetime < 1) {
                    await fail(request, reply, 'request_expired', 400);
                    return;
                }
                const token = await generateEmailToken(
                    email,
                    undefined,
                    pending.siteId,
                    pending.scope,
                    issuer,
                    config.emailSecret,
                    lifetime,
                    { browserSsoRequestId: requestId },
                );
                const grant = await verifyEmailToken(token, config.emailSecret, {
                    expectedIssuer: issuer,
                    allowBrowserSso: true,
                });
                if (!grant || typeof grant.exp !== 'number') {
                    throw new Error('Unable to create browser SSO email grant');
                }
                const binding = currentBinding(request);
                if (
                    !binding ||
                    !(await store.bindGrant({
                        requestId,
                        browserBinding: binding,
                        grantId: grant.jti,
                        now: Date.now(),
                    }))
                ) {
                    await fail(request, reply, 'request_expired', 400);
                    return;
                }
                let otpCode: string | undefined;
                if (config.otp.enabled && config.otp.secret) {
                    otpCode = generateOtpCode(config.otp.length);
                    await dependencies.otpChallengeStore.create({
                        browserSsoRequestId: requestId,
                        attemptsRemaining: config.otp.allowedAttempts,
                        challengeId,
                        createdAt: Date.now(),
                        email,
                        expiresAt: Math.min(
                            grant.exp * 1000,
                            Date.now() + config.otp.expirationSeconds * 1000,
                        ),
                        jti: grant.jti,
                        siteId: pending.siteId,
                        scope: pending.scope,
                        otpHash: hashOtpCode({
                            challengeId,
                            code: otpCode,
                            jti: grant.jti,
                            secret: config.otp.secret,
                            siteId: pending.siteId,
                        }),
                        rotationKey: hashBrowserSsoValue(`browser-sso-request:${requestId}`),
                        safeReturnUrl: new URL(
                            `/sso/signin?${new URLSearchParams({ requestId })}`,
                            issuer,
                        ).href,
                    });
                }
                await dependencies.mailer.sendVerificationEmail({
                    email,
                    token,
                    verifyUrl: new URL(`/sso/verify?${new URLSearchParams({ requestId })}`, issuer)
                        .href,
                    siteTitle:
                        target.site.hostedAuthBranding.title || config.hostedAuthBranding.title,
                    ...(otpCode === undefined
                        ? {}
                        : {
                              otpCode,
                              otpExpiresInSeconds: Math.min(config.otp.expirationSeconds, lifetime),
                          }),
                });
                await signinView(request, reply, requestId, pending, challengeId);
            });

            async function finishVerification(
                request: FastifyRequest,
                reply: FastifyReply,
                input: {
                    requestId: string;
                    pending: StoredAuthorizationRequest;
                    email: string;
                    jti: string;
                    expiresAt: number;
                },
            ): Promise<void> {
                const target = registration(input.pending.redirectUri);
                if (!target || !siteAllows(target.site, input.email, input.pending.scope)) {
                    await fail(request, reply, 'access_denied', 403);
                    return;
                }
                if (
                    !(await dependencies.verificationTokenReplayStore.consume(
                        input.jti,
                        input.expiresAt,
                    ))
                ) {
                    await fail(request, reply, 'request_expired', 400);
                    return;
                }
                const now = Date.now();
                const previousHandle = request.cookies[sessionCookie];
                const created = await store.createSession({
                    email: input.email,
                    now,
                    expiresAt: now + (policy?.sessionLifetimeSeconds ?? 28_800) * 1000,
                    ...(previousHandle === undefined ? {} : { previousHandle }),
                });
                reply.setCookie(sessionCookie, created.handle, {
                    ...cookieOptions,
                    maxAge: Math.floor((created.session.expiresAt - now) / 1000),
                });
                const binding = currentBinding(request);
                if (!binding || hashBrowserSsoValue(binding) !== input.pending.bindingHash) {
                    await view(reply, 'verify-email.ejs', target.site, {
                        copy: {
                            ...target.site.hostedAuthPageCopy.verifyEmail,
                            title: 'Email confirmed',
                            helpText:
                                'Continue to your application to start a new sign-in in this browser.',
                        },
                        email: input.email,
                        nextHref: target.startUri,
                        nextText: 'Continue to application',
                    });
                    return;
                }
                await issue(request, reply, {
                    requestId: input.requestId,
                    sessionHandle: created.handle,
                    grantId: input.jti,
                });
            }
            async function proofContext(
                request: FastifyRequest,
                reply: FastifyReply,
                value: unknown,
            ): Promise<{
                token: string;
                requestId: string;
                pending: StoredAuthorizationRequest;
                email: string;
                jti: string;
                expiresAt: number;
            } | null> {
                const parsed = proofSchema.safeParse(value);
                if (!parsed.success) {
                    await fail(request, reply, 'invalid_request', 400);
                    return null;
                }
                const { token, requestId } = parsed.data;
                const grant = await verifyEmailToken(token, config.emailSecret, {
                    expectedIssuer: issuer,
                    allowBrowserSso: true,
                });
                const pending = await store.getRequest(requestId, Date.now());
                if (
                    !grant ||
                    !pending ||
                    grant.browserSsoRequestId !== requestId ||
                    grant.siteId !== pending.siteId ||
                    grant.scope !== pending.scope ||
                    typeof grant.exp !== 'number' ||
                    pending.grantHash !== hashBrowserSsoValue(grant.jti)
                ) {
                    await fail(request, reply, 'request_expired', 400);
                    return null;
                }
                return {
                    token,
                    requestId,
                    pending,
                    email: grant.email,
                    jti: grant.jti,
                    expiresAt: grant.exp * 1000,
                };
            }
            sso.get('/sso/verify', verificationLimit, async (request, reply): Promise<void> => {
                const context = await proofContext(request, reply, request.query);
                if (!context) {
                    return;
                }
                const target = registration(context.pending.redirectUri);
                const binding = ensureBinding(request, reply);
                await view(reply, 'verify-email.ejs', target?.site, {
                    copy: {
                        ...(target?.site.hostedAuthPageCopy.verifyEmail ??
                            config.hostedAuthPageCopy.verifyEmail),
                        helpText:
                            'Confirm this account to sign in. This replaces the current browser SSO identity; existing sessions in other applications keep their normal expiry.',
                    },
                    email: context.email,
                    csrfToken: csrf(binding),
                    formAction: '/sso/verify',
                    formFields: { token: context.token, requestId: context.requestId },
                });
            });
            sso.post('/sso/verify', verificationLimit, async (request, reply): Promise<void> => {
                if (!validMutation(request)) {
                    await fail(request, reply, 'invalid_request', 403);
                    return;
                }
                const context = await proofContext(request, reply, request.body);
                if (context) {
                    await finishVerification(request, reply, context);
                }
            });
            sso.post('/sso/otp', verificationLimit, async (request, reply): Promise<void> => {
                const parsed = otpSchema.safeParse(request.body);
                if (
                    !parsed.success ||
                    !validMutation(request) ||
                    !safeCompare(
                        parsed.data.otpContext,
                        otpContext(parsed.data.requestId, parsed.data.challengeId),
                    )
                ) {
                    await fail(request, reply, 'invalid_request', 403);
                    return;
                }
                const { requestId, challengeId } = parsed.data;
                const pending = await boundRequest(request, reply, requestId);
                if (!pending) {
                    return;
                }
                const code = normaliseOtpCode(parsed.data.code, config.otp.length);
                if (code === null || !config.otp.enabled || !config.otp.secret) {
                    await signinView(
                        request,
                        reply,
                        requestId,
                        pending,
                        challengeId,
                        'Enter a valid one-time code.',
                        400,
                    );
                    return;
                }
                const result = await dependencies.otpChallengeStore.verify({
                    browserSsoRequestId: requestId,
                    challengeId,
                    code,
                    now: Date.now(),
                    secret: config.otp.secret,
                });
                if (result.category !== 'valid') {
                    await signinView(
                        request,
                        reply,
                        requestId,
                        pending,
                        result.category === 'invalid' ? challengeId : undefined,
                        'This one-time code is invalid or has expired.',
                        400,
                    );
                    return;
                }
                if (
                    hashBrowserSsoValue(result.challenge.jti) !== pending.grantHash ||
                    result.challenge.siteId !== pending.siteId ||
                    result.challenge.scope !== pending.scope
                ) {
                    await fail(request, reply, 'request_expired', 400);
                    return;
                }
                await finishVerification(request, reply, {
                    requestId,
                    pending,
                    email: result.challenge.email,
                    jti: result.challenge.jti,
                    expiresAt: result.challenge.expiresAt,
                });
            });
            sso.post('/sso/exchange', verificationLimit, async (request, reply): Promise<void> => {
                const parsed = exchangeSchema.safeParse(request.body);
                if (
                    !parsed.success ||
                    !request.headers['content-type']?.startsWith('application/json')
                ) {
                    await fail(request, reply, 'invalid_request', 400);
                    return;
                }
                const inspected = await store.inspectCode(parsed.data.code, Date.now());
                const target = registration(parsed.data.redirectUri);
                if (
                    !inspected ||
                    !target ||
                    inspected.code.siteId !== target.site.id ||
                    inspected.code.redirectUri !== parsed.data.redirectUri
                ) {
                    await fail(request, reply, 'code_rejected', 400);
                    return;
                }
                if (!inspected.session) {
                    await fail(request, reply, 'session_expired', 401);
                    return;
                }
                if (!siteAllows(target.site, inspected.session.email, inspected.code.scope)) {
                    await fail(request, reply, 'access_denied', 403);
                    return;
                }
                const result = await store.redeemCode({
                    ...parsed.data,
                    siteId: target.site.id,
                    scope: inspected.code.scope,
                    email: inspected.session.email,
                    now: Date.now(),
                });
                if (result.kind !== 'redeemed') {
                    await fail(
                        request,
                        reply,
                        result.kind,
                        result.kind === 'session_expired' ? 401 : 400,
                    );
                    return;
                }
                // Reload may have happened while the atomic store operation awaited
                // I/O. Recheck the live grant before signing, even after consumption.
                const current = registration(parsed.data.redirectUri);
                if (
                    !current ||
                    !siteAllows(current.site, result.session.email, result.code.scope)
                ) {
                    await fail(request, reply, 'access_denied', 403);
                    return;
                }
                const lifetime = Math.min(
                    config.jwtExpirationSeconds,
                    Math.floor((result.session.expiresAt - Date.now()) / 1000),
                );
                if (lifetime < 1) {
                    await fail(request, reply, 'session_expired', 401);
                    return;
                }
                const accessToken = await signAccessToken(
                    result.session.email,
                    result.code.scope,
                    current.site.id,
                    [...current.site.origins].sort(),
                    issuer,
                    config.jwtSecret,
                    lifetime,
                );
                const finalTarget = registration(parsed.data.redirectUri);
                if (
                    !finalTarget ||
                    !siteAllows(finalTarget.site, result.session.email, result.code.scope)
                ) {
                    await fail(request, reply, 'access_denied', 403);
                    return;
                }
                reply.send({ accessToken });
            });
            function signOutReturn(value: unknown): string | null | undefined {
                const parsed = signOutSchema.safeParse(value);
                if (!parsed.success) {
                    return null;
                }
                const uri = parsed.data.returnUri;
                return uri === undefined ||
                    config.sites.some((site) =>
                        site.sso?.some((entry) => entry.signedOutUri === uri),
                    )
                    ? uri
                    : null;
            }
            sso.get('/sso/signout', pageLimit, async (request, reply): Promise<void> => {
                const returnUri = signOutReturn(request.query);
                if (returnUri === null) {
                    await fail(request, reply, 'invalid_callback', 400);
                    return;
                }
                const handle = request.cookies[sessionCookie];
                const session =
                    handle === undefined ? null : await store.getSession(handle, Date.now());
                const binding = ensureBinding(request, reply);
                const returnSite =
                    returnUri === undefined
                        ? undefined
                        : config.sites.find((site) =>
                              site.sso?.some((entry) => entry.signedOutUri === returnUri),
                          );
                await view(reply, 'verify-email.ejs', returnSite, {
                    copy: {
                        ...config.hostedAuthPageCopy.verifyEmail,
                        title: 'End browser SSO session',
                        helpText:
                            'This prevents new application sessions in this browser. Existing sessions in other applications keep their normal expiry.',
                        continueButton: 'End browser SSO session',
                    },
                    email: session?.email ?? null,
                    csrfToken: csrf(binding),
                    formAction: '/sso/signout',
                    formFields: returnUri === undefined ? {} : { returnUri },
                });
            });
            sso.post('/sso/signout', mutationLimit, async (request, reply): Promise<void> => {
                if (!validMutation(request)) {
                    await fail(request, reply, 'invalid_request', 403);
                    return;
                }
                const returnUri = signOutReturn(request.body);
                if (returnUri === null) {
                    await fail(request, reply, 'invalid_callback', 400);
                    return;
                }
                const handle = request.cookies[sessionCookie];
                const binding = currentBinding(request);
                await store.endBrowserSession({
                    now: Date.now(),
                    ...(handle === undefined ? {} : { handle }),
                    ...(binding === undefined ? {} : { browserBinding: binding }),
                });
                reply.clearCookie(sessionCookie, cookieOptions);
                if (returnUri !== undefined) {
                    reply.code(303).redirect(returnUri);
                    return;
                }
                await view(reply, 'verify-email.ejs', undefined, {
                    copy: {
                        ...config.hostedAuthPageCopy.verifyEmail,
                        title: 'Browser SSO session ended',
                        helpText:
                            'You can close this page. Existing application sessions keep their normal expiry.',
                    },
                    nextHref: '/',
                    nextText: 'Magic Link SSO',
                });
            });
        },
        {
            logSerializers: {
                req(value: unknown): string {
                    // Fastify logs requests before handlers. Strip all SSO query
                    // fields here, rather than attempting to redact them afterward.
                    const url = readField(value, 'url') ?? '/sso';
                    return url.split('?')[0] ?? '/sso';
                },
            },
        },
    );
}
