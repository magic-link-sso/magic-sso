// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Wojciech Polak

import cookie from '@fastify/cookie';
import formbody from '@fastify/formbody';
import Fastify, { type FastifyInstance, type FastifyReply, type FastifyRequest } from 'fastify';
import { randomBytes, timingSafeEqual } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { protectedBadgeUrl, signinBadgeUrl } from 'magic-sso-example-ui';
import {
    buildAuthCookieOptions,
    buildLoginTarget,
    buildVerifyUrl,
    getJwtSecret,
    getLoginErrorMessage,
    normaliseReturnUrl,
    resolveMagicSsoConfig,
    verifyAuthToken,
    verifyRequestAuth,
} from './auth.js';
import {
    renderHomePage,
    renderLoginPage,
    renderProtectedPage,
    renderVerifyEmailConfirmationPage,
} from './html.js';
import { buildFailureResult, readMessage, readServerUrlConfigError } from './signin-utils.js';

interface SignInBody {
    email?: string;
    returnUrl?: string;
    verifyUrl?: string;
}

interface LoginQuery {
    error?: string;
    message?: string;
    returnUrl?: string;
    status?: string;
}

interface VerifyEmailQuery {
    returnUrl?: string;
    token?: string;
}

interface VerifyEmailBody {
    csrfToken?: string;
    returnUrl?: string;
    token?: string;
}

interface VerifyEmailResponse {
    accessToken: string;
}

interface VerifyEmailPreviewResponse {
    email: string;
}

interface SignInSuccessResponse {
    message: string;
}

interface CreateAppOptions {
    logger?: false | { level: 'trace' | 'debug' | 'info' | 'warn' | 'error' | 'fatal' };
}

const sharedStylesPath = fileURLToPath(import.meta.resolve('magic-sso-example-ui/styles.css'));
const sharedSigninBadgeFilePath = fileURLToPath(signinBadgeUrl);
const sharedProtectedBadgeFilePath = fileURLToPath(protectedBadgeUrl);
const sharedStylesRoute = '/shared/styles.css';
const sharedSigninBadgeRoute = '/shared/assets/signin-page-badge.svg';
const sharedProtectedBadgeRoute = '/shared/assets/protected-page-badge.svg';
const verifyCsrfCookieName = 'magic-sso-verify-csrf';
const verifyTokenCookieName = 'magic-sso-verify-token';

function readString(value: unknown): string | undefined {
    return typeof value === 'string' && value.length > 0 ? value : undefined;
}

function isVerifyEmailResponse(value: unknown): value is VerifyEmailResponse {
    return (
        typeof value === 'object' &&
        value !== null &&
        'accessToken' in value &&
        typeof value.accessToken === 'string' &&
        value.accessToken.length > 0
    );
}

function isVerifyEmailPreviewResponse(value: unknown): value is VerifyEmailPreviewResponse {
    return (
        typeof value === 'object' &&
        value !== null &&
        'email' in value &&
        typeof value.email === 'string' &&
        value.email.length > 0
    );
}

function isSignInSuccessResponse(value: unknown): value is SignInSuccessResponse {
    return (
        typeof value === 'object' &&
        value !== null &&
        'message' in value &&
        typeof value.message === 'string' &&
        value.message === 'Verification email sent'
    );
}

function createVerifyCsrfToken(): string {
    return randomBytes(32).toString('base64url');
}

function readCookieValue(cookieHeader: string | undefined, cookieName: string): string | undefined {
    if (typeof cookieHeader !== 'string' || cookieHeader.length === 0) {
        return undefined;
    }

    for (const entry of cookieHeader.split(';')) {
        const [name, ...valueParts] = entry.trim().split('=');
        if (name === cookieName) {
            const value = valueParts.join('=');
            return value.length > 0 ? decodeURIComponent(value) : undefined;
        }
    }

    return undefined;
}

function readPreviewSecret(): string | null {
    const previewSecret = process.env['MAGICSSO_PREVIEW_SECRET'];
    return typeof previewSecret === 'string' && previewSecret.length > 0 ? previewSecret : null;
}

function safeCompare(left: string, right: string): boolean {
    const leftBuffer = Buffer.from(left);
    const rightBuffer = Buffer.from(right);
    if (leftBuffer.length !== rightBuffer.length) {
        return false;
    }

    return timingSafeEqual(leftBuffer, rightBuffer);
}

function buildVerifyCsrfCookieOptions(request: FastifyRequest): {
    httpOnly: true;
    path: '/verify-email';
    sameSite: 'strict';
    secure: boolean;
} {
    return {
        httpOnly: true,
        path: '/verify-email',
        sameSite: 'strict',
        secure: getRequestOrigin(request).startsWith('https://'),
    };
}

function buildVerifyTokenCookieOptions(request: FastifyRequest): {
    httpOnly: true;
    path: '/verify-email';
    sameSite: 'strict';
    secure: boolean;
} {
    return buildVerifyCsrfCookieOptions(request);
}

function clearVerifyEmailCookies(request: FastifyRequest, reply: FastifyReply): void {
    reply.clearCookie(verifyCsrfCookieName, buildVerifyCsrfCookieOptions(request));
    reply.clearCookie(verifyTokenCookieName, buildVerifyTokenCookieOptions(request));
}

function buildUnexpectedUpstreamMessage(serverUrl: string): string {
    return `No Magic Link SSO JSON endpoint responded at ${new URL('/signin', serverUrl).toString()}. Start \`pnpm dev:server\` or update MAGICSSO_SERVER_URL.`;
}

function getRequestOrigin(request: FastifyRequest): string {
    const forwardedProto = readString(request.headers['x-forwarded-proto']);
    const forwardedHost = readString(request.headers['x-forwarded-host']);
    const host = forwardedHost ?? request.headers.host ?? 'localhost:3005';
    const protocol =
        forwardedProto ?? request.protocol ?? (host.startsWith('localhost') ? 'http' : 'https');
    return `${protocol}://${host}`;
}

function hasSameOriginMutationSource(request: FastifyRequest): boolean {
    const expectedOrigin = getRequestOrigin(request);
    const originHeader = readString(request.headers.origin);
    if (typeof originHeader === 'string') {
        return originHeader === expectedOrigin;
    }

    const refererHeader = readString(request.headers.referer);
    if (typeof refererHeader !== 'string') {
        return false;
    }

    try {
        return new URL(refererHeader).origin === expectedOrigin;
    } catch {
        return false;
    }
}

function buildLoginRedirectUrl(
    request: FastifyRequest,
    returnUrl: string,
    options: { error?: string; message?: string; status?: 'error' | 'success' } = {},
): string {
    const loginUrl = new URL('/login', getRequestOrigin(request));
    loginUrl.searchParams.set('returnUrl', returnUrl);

    if (typeof options.error === 'string') {
        loginUrl.searchParams.set('error', options.error);
    }
    if (typeof options.message === 'string') {
        loginUrl.searchParams.set('message', options.message);
    }
    if (typeof options.status === 'string') {
        loginUrl.searchParams.set('status', options.status);
    }

    return `${loginUrl.pathname}${loginUrl.search}`;
}

async function readResponsePayload(response: Response): Promise<unknown> {
    return response.json().catch(async () => ({
        message: await response.text().catch(() => ''),
    }));
}

async function serveFile(
    reply: FastifyReply,
    filePath: string,
    contentType: string,
): Promise<FastifyReply> {
    const fileContents = await readFile(filePath);
    reply.type(contentType);
    return reply.send(fileContents);
}

export async function createApp(options: CreateAppOptions = {}): Promise<FastifyInstance> {
    const app = Fastify({
        logger:
            typeof options.logger === 'undefined'
                ? {
                      level: process.env['LOG_LEVEL'] === 'debug' ? 'debug' : 'info',
                  }
                : options.logger,
    });

    await app.register(cookie);
    await app.register(formbody);

    app.get(sharedStylesRoute, async (_request, reply) =>
        serveFile(reply, sharedStylesPath, 'text/css; charset=utf-8'),
    );
    app.get(sharedSigninBadgeRoute, async (_request, reply) =>
        serveFile(reply, sharedSigninBadgeFilePath, 'image/svg+xml; charset=utf-8'),
    );
    app.get(sharedProtectedBadgeRoute, async (_request, reply) =>
        serveFile(reply, sharedProtectedBadgeFilePath, 'image/svg+xml; charset=utf-8'),
    );

    app.get('/', async (request, reply) => {
        const appOrigin = getRequestOrigin(request);
        const auth = await verifyRequestAuth(request.headers.cookie, appOrigin);
        reply.type('text/html; charset=utf-8');
        return reply.send(
            renderHomePage({
                auth,
                loginTarget: buildLoginTarget(appOrigin, appOrigin),
                signinBadgePath: sharedSigninBadgeRoute,
            }),
        );
    });

    app.get<{ Querystring: LoginQuery }>('/login', async (request, reply) => {
        const appOrigin = getRequestOrigin(request);
        const returnUrl = normaliseReturnUrl(request.query.returnUrl, appOrigin, appOrigin);
        const errorMessage = getLoginErrorMessage(readString(request.query.error));
        const status = readString(request.query.status);
        const rawMessage = readString(request.query.message);
        const message =
            typeof errorMessage === 'string'
                ? {
                      kind: 'error' as const,
                      text: errorMessage,
                  }
                : typeof rawMessage === 'string'
                  ? {
                        kind: status === 'success' ? ('success' as const) : ('error' as const),
                        text: rawMessage,
                    }
                  : undefined;

        reply.type('text/html; charset=utf-8');
        return reply.send(
            renderLoginPage({
                appOrigin,
                loginTarget: buildLoginTarget(appOrigin, returnUrl),
                message: typeof message === 'undefined' ? undefined : message,
                returnUrl,
                signinBadgePath: sharedSigninBadgeRoute,
                verifyUrl: buildVerifyUrl(appOrigin, returnUrl),
            }),
        );
    });

    app.post<{ Body: SignInBody }>('/api/signin', async (request, reply) => {
        const appOrigin = getRequestOrigin(request);
        const email = readString(request.body.email);
        const returnUrl = normaliseReturnUrl(
            readString(request.body.returnUrl),
            appOrigin,
            appOrigin,
        );
        const verifyUrl =
            readString(request.body.verifyUrl) ?? buildVerifyUrl(appOrigin, returnUrl);

        if (typeof email !== 'string' || typeof verifyUrl !== 'string' || verifyUrl.length === 0) {
            return reply.redirect(
                buildLoginRedirectUrl(request, returnUrl, {
                    message: 'Invalid sign-in request payload.',
                    status: 'error',
                }),
            );
        }

        const resolvedConfig = resolveMagicSsoConfig();
        if (resolvedConfig.serverUrl.length === 0) {
            return reply.redirect(
                buildLoginRedirectUrl(request, returnUrl, {
                    message: 'MAGICSSO_SERVER_URL is not configured.',
                    status: 'error',
                }),
            );
        }

        const serverUrlConfigError = readServerUrlConfigError(resolvedConfig.serverUrl, appOrigin);
        if (typeof serverUrlConfigError === 'string') {
            return reply.redirect(
                buildLoginRedirectUrl(request, returnUrl, {
                    message: serverUrlConfigError,
                    status: 'error',
                }),
            );
        }

        try {
            const ssoResponse = await fetch(new URL('/signin', resolvedConfig.serverUrl), {
                method: 'POST',
                headers: {
                    accept: 'application/json',
                    'content-type': 'application/json',
                },
                body: JSON.stringify({
                    email,
                    returnUrl,
                    verifyUrl,
                }),
                cache: 'no-store',
            });

            if (!ssoResponse.ok) {
                const payload = await readResponsePayload(ssoResponse);
                return reply.redirect(
                    buildLoginRedirectUrl(request, returnUrl, {
                        message: buildFailureResult(payload).message,
                        status: 'error',
                    }),
                );
            }

            const payload: unknown = await readResponsePayload(ssoResponse);
            if (!isSignInSuccessResponse(payload)) {
                const contentType = ssoResponse.headers.get('content-type');
                const responsePreview =
                    typeof payload === 'object' &&
                    payload !== null &&
                    'message' in payload &&
                    typeof payload.message === 'string'
                        ? payload.message.slice(0, 160)
                        : JSON.stringify(payload).slice(0, 160);

                request.log.error(
                    {
                        contentType,
                        payload,
                        responsePreview,
                        serverUrl: resolvedConfig.serverUrl,
                        status: ssoResponse.status,
                    },
                    'Magic Link SSO server returned an invalid sign-in success payload',
                );
                return reply.redirect(
                    buildLoginRedirectUrl(request, returnUrl, {
                        message: buildUnexpectedUpstreamMessage(resolvedConfig.serverUrl),
                        status: 'error',
                    }),
                );
            }

            return reply.redirect(
                buildLoginRedirectUrl(request, returnUrl, {
                    message: 'Verification email sent.',
                    status: 'success',
                }),
            );
        } catch (error: unknown) {
            return reply.redirect(
                buildLoginRedirectUrl(request, returnUrl, {
                    message: readMessage(error) ?? 'Failed to send verification email.',
                    status: 'error',
                }),
            );
        }
    });

    app.get<{ Querystring: VerifyEmailQuery }>('/verify-email', async (request, reply) => {
        const appOrigin = getRequestOrigin(request);
        const token = readString(request.query.token);
        const returnUrl = normaliseReturnUrl(request.query.returnUrl, appOrigin, appOrigin);

        if (typeof token !== 'string') {
            return reply.redirect(
                buildLoginRedirectUrl(request, returnUrl, {
                    error: 'missing-verification-token',
                }),
            );
        }

        const resolvedConfig = resolveMagicSsoConfig();
        if (resolvedConfig.serverUrl.length === 0) {
            return reply.redirect(
                buildLoginRedirectUrl(request, returnUrl, {
                    error: 'verify-email-misconfigured',
                }),
            );
        }
        const previewSecret = readPreviewSecret();
        if (previewSecret === null) {
            return reply.redirect(
                buildLoginRedirectUrl(request, returnUrl, {
                    error: 'verify-email-misconfigured',
                }),
            );
        }

        try {
            const previewUrl = new URL('/verify-email', resolvedConfig.serverUrl);
            previewUrl.searchParams.set('token', token);

            const previewResponse = await fetch(previewUrl, {
                headers: {
                    accept: 'application/json',
                    'x-magic-sso-preview-secret': previewSecret,
                },
                cache: 'no-store',
            });

            if (!previewResponse.ok) {
                return reply.redirect(
                    buildLoginRedirectUrl(request, returnUrl, {
                        error: 'verify-email-failed',
                    }),
                );
            }

            const payload: unknown = await previewResponse.json();
            if (!isVerifyEmailPreviewResponse(payload)) {
                return reply.redirect(
                    buildLoginRedirectUrl(request, returnUrl, {
                        error: 'verify-email-failed',
                    }),
                );
            }

            const csrfToken = createVerifyCsrfToken();
            reply.setCookie(verifyCsrfCookieName, csrfToken, buildVerifyCsrfCookieOptions(request));
            reply.setCookie(verifyTokenCookieName, token, buildVerifyTokenCookieOptions(request));
            reply.type('text/html; charset=utf-8');
            return reply.send(
                renderVerifyEmailConfirmationPage({
                    csrfToken,
                    email: payload.email,
                    returnUrl,
                    signinBadgePath: sharedSigninBadgeRoute,
                }),
            );
        } catch {
            return reply.redirect(
                buildLoginRedirectUrl(request, returnUrl, {
                    error: 'verify-email-failed',
                }),
            );
        }
    });

    app.post<{ Body: VerifyEmailBody }>('/verify-email', async (request, reply) => {
        const appOrigin = getRequestOrigin(request);
        const submittedToken = readString(request.body.token);
        const cookieToken = readCookieValue(request.headers.cookie, verifyTokenCookieName);
        const submittedCsrfToken = readString(request.body.csrfToken);
        const returnUrl = normaliseReturnUrl(
            readString(request.body.returnUrl),
            appOrigin,
            appOrigin,
        );
        const cookieCsrfToken = readCookieValue(request.headers.cookie, verifyCsrfCookieName);
        const token =
            typeof submittedToken === 'string'
                ? typeof cookieToken === 'string' && submittedToken !== cookieToken
                    ? undefined
                    : submittedToken
                : cookieToken;

        if (
            typeof token !== 'string' ||
            typeof submittedCsrfToken !== 'string' ||
            typeof cookieCsrfToken !== 'string' ||
            !safeCompare(submittedCsrfToken, cookieCsrfToken)
        ) {
            clearVerifyEmailCookies(request, reply);
            return reply.redirect(
                buildLoginRedirectUrl(request, returnUrl, {
                    error: 'verify-email-failed',
                }),
            );
        }

        const resolvedConfig = resolveMagicSsoConfig();
        if (resolvedConfig.serverUrl.length === 0) {
            clearVerifyEmailCookies(request, reply);
            return reply.redirect(
                buildLoginRedirectUrl(request, returnUrl, {
                    error: 'verify-email-misconfigured',
                }),
            );
        }

        try {
            const verifyUrl = new URL('/verify-email', resolvedConfig.serverUrl);

            const verifyResponse = await fetch(verifyUrl, {
                method: 'POST',
                headers: {
                    accept: 'application/json',
                    'content-type': 'application/json',
                },
                body: JSON.stringify({ token }),
                cache: 'no-store',
            });

            if (!verifyResponse.ok) {
                clearVerifyEmailCookies(request, reply);
                return reply.redirect(
                    buildLoginRedirectUrl(request, returnUrl, {
                        error: 'verify-email-failed',
                    }),
                );
            }

            const payload: unknown = await verifyResponse.json();
            if (!isVerifyEmailResponse(payload)) {
                clearVerifyEmailCookies(request, reply);
                return reply.redirect(
                    buildLoginRedirectUrl(request, returnUrl, {
                        error: 'verify-email-failed',
                    }),
                );
            }

            const jwtSecret = getJwtSecret();
            if (jwtSecret === null) {
                clearVerifyEmailCookies(request, reply);
                return reply.redirect(
                    buildLoginRedirectUrl(request, returnUrl, {
                        error: 'session-verification-misconfigured',
                    }),
                );
            }

            const auth = await verifyAuthToken(payload.accessToken, jwtSecret, {
                expectedAudience: appOrigin,
                expectedIssuer: new URL(resolvedConfig.serverUrl).origin,
            });
            if (auth === null) {
                clearVerifyEmailCookies(request, reply);
                return reply.redirect(
                    buildLoginRedirectUrl(request, returnUrl, {
                        error: 'session-verification-failed',
                    }),
                );
            }

            const resolvedCookieConfig = resolveMagicSsoConfig();
            clearVerifyEmailCookies(request, reply);
            reply.setCookie(
                resolvedCookieConfig.cookieName,
                payload.accessToken,
                buildAuthCookieOptions(resolvedCookieConfig),
            );
            return reply.redirect(returnUrl);
        } catch {
            clearVerifyEmailCookies(request, reply);
            return reply.redirect(
                buildLoginRedirectUrl(request, returnUrl, {
                    error: 'verify-email-failed',
                }),
            );
        }
    });

    app.post('/logout', async (request, reply) => {
        if (!hasSameOriginMutationSource(request)) {
            reply.code(403).send('Forbidden');
            return;
        }

        const resolvedCookieConfig = resolveMagicSsoConfig();
        reply.clearCookie(
            resolvedCookieConfig.cookieName,
            buildAuthCookieOptions(resolvedCookieConfig),
        );
        return reply.redirect('/');
    });

    app.get('/protected', async (request, reply) => {
        const appOrigin = getRequestOrigin(request);
        const auth = await verifyRequestAuth(request.headers.cookie, appOrigin);

        if (auth === null) {
            return reply.redirect(buildLoginTarget(appOrigin, `${appOrigin}/protected`));
        }

        reply.type('text/html; charset=utf-8');
        return reply.send(
            renderProtectedPage({
                auth,
                protectedBadgePath: sharedProtectedBadgeRoute,
            }),
        );
    });

    return app;
}
