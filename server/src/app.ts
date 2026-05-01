/**
 * server/src/app.ts
 *
 * Magic Link SSO Copyright (C) 2026 Wojciech Polak
 *
 * This program is free software; you can redistribute it and/or modify it
 * under the terms of the GNU General Public License as published by the
 * Free Software Foundation; either version 3 of the License, or (at your
 * option) any later version.
 *
 * This program is distributed in the hope that it will be useful,
 * but WITHOUT ANY WARRANTY; without even the implied warranty of
 * MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE. See the
 * GNU General Public License for more details.
 *
 * You should have received a copy of the GNU General Public License along
 * with this program. If not, see <https://www.gnu.org/licenses/>.
 */

import cookie from '@fastify/cookie';
import type { CookieSerializeOptions } from '@fastify/cookie';
import formbody from '@fastify/formbody';
import rateLimit from '@fastify/rate-limit';
import view from '@fastify/view';
import ejs from 'ejs';
import Fastify, {
    type FastifyBaseLogger,
    type FastifyInstance,
    type FastifyReply,
    type FastifyRequest,
    type FastifyServerOptions,
} from 'fastify';
import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { z } from 'zod';
import {
    generateEmailToken,
    signAccessToken,
    verifyAccessToken,
    verifyEmailToken,
} from './auth.js';
import {
    createDefaultHostedAuthPageCopy,
    hasSuspiciousRedirectPath,
    loadConfig,
    type AppConfig,
    type SiteConfig,
} from './config.js';
import { createVerificationEmailSender, type VerificationEmailSender } from './email.js';
import { createLoggerOptions } from './logger.js';
import type { PerEmailSignInLimiter } from './perEmailSignInLimiter.js';
import { FULL_ACCESS_SCOPE, normalizeRequestedScope } from './scope.js';
import { createSecurityState, type SharedSecurityState } from './securityState.js';
import type { SessionRevocationStore } from './sessionRevocationStore.js';
import { type VerificationTokenReplayStore } from './verificationTokenReplayStore.js';
import { getStartupProbeHeaderName } from './startupProbe.js';

interface BuildAppOptions {
    config?: AppConfig;
    logger?: FastifyServerOptions['logger'];
    mailer?: VerificationEmailSender;
    perEmailSignInLimiter?: PerEmailSignInLimiter;
    securityState?: SharedSecurityState;
    sessionRevocationStore?: SessionRevocationStore;
    startupProbeToken?: string;
    verificationTokenReplayStore?: VerificationTokenReplayStore;
}

interface SignInQuerystring {
    returnUrl?: string;
    scope?: string;
    verifyUrl?: string;
}

interface HostedAuthViewConfig {
    hostedAuthBranding: AppConfig['hostedAuthBranding'];
    hostedAuthPageCopy: AppConfig['hostedAuthPageCopy'];
}

interface HtmlSecurityContext {
    cspNonce: string;
    csrfToken: string | null;
}

type SigninPageMode = 'confirmation' | 'form';

const verifyEmailPreviewSecretHeaderName = 'x-magic-sso-preview-secret';

function emptyStringAsUndefined(value: string | undefined): string | undefined {
    return typeof value === 'string' && value.trim() === '' ? undefined : value;
}

function optionalStringField(schema: z.ZodString) {
    return z
        .union([schema, z.literal('')])
        .optional()
        .transform((value) => emptyStringAsUndefined(value));
}

const signInQuerySchema = z.object({
    returnUrl: optionalStringField(z.string().min(1)),
    scope: optionalStringField(z.string().min(1)),
    verifyUrl: optionalStringField(z.string().url()),
});

const submittedEmailSchema = z.string().trim().max(254).email();

const signInBodySchema = z.object({
    email: submittedEmailSchema,
    returnUrl: optionalStringField(z.string().min(1)),
    scope: optionalStringField(z.string().min(1)),
    verifyUrl: optionalStringField(z.string().url()),
});

const verifyEmailQuerySchema = z.object({
    token: z.string().min(1),
});

const sessionRevocationCheckBodySchema = z.object({
    jti: z.string().min(1),
});

const verifyEmailBodySchema = z.object({
    token: z.string().min(1).optional(),
});

function wantsHtmlResponse(request: FastifyRequest): boolean {
    const acceptHeader = request.headers.accept;
    return typeof acceptHeader === 'string' && acceptHeader.includes('text/html');
}

function expectsJsonResponse(request: FastifyRequest): boolean {
    const contentType = request.headers['content-type'];
    if (typeof contentType === 'string' && contentType.includes('application/json')) {
        return true;
    }

    return !wantsHtmlResponse(request);
}

function getErrorStatusCode(error: unknown): number | undefined {
    if (typeof error !== 'object' || error === null) {
        return undefined;
    }

    const statusCode = Reflect.get(error, 'statusCode');
    return typeof statusCode === 'number' ? statusCode : undefined;
}

function getErrorMessage(error: unknown): string | undefined {
    if (typeof error !== 'object' || error === null) {
        return undefined;
    }

    const message = Reflect.get(error, 'message');
    return typeof message === 'string' && message.length > 0 ? message : undefined;
}

function hasSafeApiContentType(request: FastifyRequest, config: AppConfig): boolean {
    const contentType = request.headers['content-type'];
    return (
        typeof contentType === 'string' &&
        contentType.includes('application/json') &&
        hasSameOriginMutationSource(request, config)
    );
}

function hasSameOriginMutationSource(request: FastifyRequest, config: AppConfig): boolean {
    const appOrigin = getAppOrigin(config);
    const origin = request.headers.origin;
    if (typeof origin === 'string' && origin !== appOrigin) {
        return false;
    }

    const fetchSite = request.headers['sec-fetch-site'];
    return (
        typeof fetchSite !== 'string' ||
        fetchSite === 'same-origin' ||
        fetchSite === 'same-site' ||
        fetchSite === 'none'
    );
}

async function renderSigninPage(
    reply: FastifyReply,
    viewConfig: HostedAuthViewConfig,
    security: HtmlSecurityContext,
    options: {
        error: false | string;
        message: false | string;
        mode?: SigninPageMode;
        returnUrl: string;
        scope: string;
        verifyUrl: string;
        statusCode?: number;
    },
): Promise<void> {
    const mode = options.mode ?? 'form';
    await reply
        .header('Cache-Control', 'no-store')
        .header('Pragma', 'no-cache')
        .code(options.statusCode ?? 200)
        .view('signin.ejs', {
            branding: viewConfig.hostedAuthBranding,
            copy: viewConfig.hostedAuthPageCopy.signin,
            cspNonce: security.cspNonce,
            csrfToken: security.csrfToken,
            mode,
            lang: viewConfig.hostedAuthPageCopy.lang,
            returnUrl: options.returnUrl,
            scope: options.scope,
            useDifferentEmailHref:
                mode === 'confirmation'
                    ? buildSigninPath({
                          returnUrl: options.returnUrl,
                          scope: options.scope,
                          verifyUrl: options.verifyUrl,
                      })
                    : null,
            verifyUrl: options.verifyUrl,
            message: options.message,
            error: options.error,
        });
}

async function renderLandingPage(
    reply: FastifyReply,
    viewConfig: HostedAuthViewConfig,
    security: HtmlSecurityContext,
): Promise<void> {
    await reply
        .header('Cache-Control', 'no-store')
        .header('Pragma', 'no-cache')
        .code(200)
        .view('root.ejs', {
            branding: viewConfig.hostedAuthBranding,
            cspNonce: security.cspNonce,
            lang: viewConfig.hostedAuthPageCopy.lang,
        });
}

async function renderVerifyEmailPage(
    reply: FastifyReply,
    viewConfig: HostedAuthViewConfig,
    security: HtmlSecurityContext,
    options: {
        email: string | null;
        error: false | string;
        statusCode?: number;
    },
): Promise<void> {
    await reply
        .header('Cache-Control', 'no-store')
        .header('Pragma', 'no-cache')
        .header('Referrer-Policy', 'no-referrer')
        .code(options.statusCode ?? 200)
        .view('verify-email.ejs', {
            branding: viewConfig.hostedAuthBranding,
            copy: viewConfig.hostedAuthPageCopy.verifyEmail,
            cspNonce: security.cspNonce,
            csrfToken: security.csrfToken,
            email: options.email,
            lang: viewConfig.hostedAuthPageCopy.lang,
            error: options.error,
        });
}

function defaultVerifyUrl(config: AppConfig): string {
    return new URL('/verify-email', config.appUrl).toString();
}

function getAppOrigin(config: AppConfig): string {
    return new URL(config.appUrl).origin;
}

function parseTrustedAbsoluteUrl(url: string): URL | null {
    try {
        const parsedUrl = new URL(url);
        if (parsedUrl.protocol !== 'http:' && parsedUrl.protocol !== 'https:') {
            return null;
        }

        return parsedUrl;
    } catch {
        return null;
    }
}

function buildSigninPath(options: { returnUrl: string; scope: string; verifyUrl: string }): string {
    const query = new URLSearchParams();
    if (options.returnUrl !== '') {
        query.set('returnUrl', options.returnUrl);
    }
    if (options.scope !== '') {
        query.set('scope', options.scope);
    }
    if (options.verifyUrl !== '') {
        query.set('verifyUrl', options.verifyUrl);
    }

    const queryString = query.toString();
    return queryString === '' ? '/signin' : `/signin?${queryString}`;
}

function findSiteById(config: AppConfig, siteId: string): SiteConfig | undefined {
    return config.sites.find((site) => site.id === siteId);
}

function findSiteByOrigin(config: AppConfig, origin: string): SiteConfig | undefined {
    return config.sites.find((site) => site.origins.has(origin));
}

function siteAllowsRedirectUrl(site: SiteConfig, redirectUrl: URL): boolean {
    return site.allowedRedirectUris.some((rule) => {
        if (rule.origin !== redirectUrl.origin) {
            return false;
        }

        if (rule.match === 'exact') {
            return redirectUrl.pathname === rule.pathname;
        }

        if (redirectUrl.pathname === rule.pathname) {
            return true;
        }

        if (!redirectUrl.pathname.startsWith(rule.pathname)) {
            return false;
        }

        return rule.pathname.endsWith('/') || redirectUrl.pathname[rule.pathname.length] === '/';
    });
}

function normaliseRedirectUrlForSite(
    redirectUrl: string | undefined,
    site: SiteConfig,
): string | null | undefined {
    if (typeof redirectUrl === 'undefined') {
        return undefined;
    }

    if (hasSuspiciousRedirectPath(redirectUrl)) {
        return null;
    }

    const parsedUrl = parseTrustedAbsoluteUrl(redirectUrl);
    if (parsedUrl === null || !siteAllowsRedirectUrl(site, parsedUrl)) {
        return null;
    }

    return parsedUrl.toString();
}

function readBearerAccessToken(request: FastifyRequest): string | undefined {
    const authorization = request.headers.authorization;
    if (typeof authorization !== 'string') {
        return undefined;
    }

    const [scheme, token, ...extra] = authorization.split(/\s+/u);
    if (scheme?.toLowerCase() !== 'bearer' || typeof token !== 'string' || extra.length > 0) {
        return undefined;
    }

    return token.length > 0 ? token : undefined;
}

function readRequestAccessToken(request: FastifyRequest, config: AppConfig): string | undefined {
    return readBearerAccessToken(request) ?? request.cookies[config.cookieName];
}

function audienceIncludes(
    audience: string | string[] | undefined,
    expectedAudience: string,
): boolean {
    return (
        audience === expectedAudience ||
        (Array.isArray(audience) && audience.includes(expectedAudience))
    );
}

async function revokeRequestAccessToken(options: {
    config: AppConfig;
    request: FastifyRequest;
    sessionRevocationStore: SessionRevocationStore;
}): Promise<void> {
    const token = readRequestAccessToken(options.request, options.config);
    if (typeof token !== 'string') {
        return;
    }

    const payload = await verifyAccessToken(token, options.config.jwtSecret, {
        expectedIssuer: getAppOrigin(options.config),
    });
    if (payload === null || typeof payload.exp !== 'number') {
        return;
    }

    await options.sessionRevocationStore.revoke(payload.jti, payload.exp * 1000);
}

function hashEmailForLogs(config: AppConfig, email: string): string {
    return createHmac('sha256', config.csrfSecret).update(email.trim().toLowerCase()).digest('hex');
}

function extractEmailDomain(email: string): string | undefined {
    const [, domain] = email.trim().toLowerCase().split('@', 2);
    return typeof domain === 'string' && domain.length > 0 ? domain : undefined;
}

function logRejectedSignIn(
    config: AppConfig,
    request: FastifyRequest,
    details: {
        email?: string | undefined;
        messageKey: HostedAuthFeedbackKey | 'invalidRequest';
        returnUrl?: string | undefined;
        scope?: string | undefined;
        verifyUrl?: string | undefined;
    },
): void {
    const email = details.email?.trim();
    request.log.info(
        {
            emailDomain: typeof email === 'string' ? extractEmailDomain(email) : undefined,
            emailHash: typeof email === 'string' ? hashEmailForLogs(config, email) : undefined,
            messageKey: details.messageKey,
            returnUrl: details.returnUrl,
            scope: details.scope,
            verifyUrl: details.verifyUrl,
        },
        'Rejected sign-in request',
    );
}

function siteAllows(site: SiteConfig, email: string, requestedScope: string): boolean {
    const grantedScopes = site.accessRules.get(email.toLowerCase());
    if (typeof grantedScopes === 'undefined') {
        return false;
    }

    if (requestedScope === FULL_ACCESS_SCOPE) {
        return grantedScopes.has(FULL_ACCESS_SCOPE);
    }

    return grantedScopes.has(FULL_ACCESS_SCOPE) || grantedScopes.has(requestedScope);
}

function buildAuthCookieOptions(config: AppConfig): CookieSerializeOptions {
    const cookieOptions: CookieSerializeOptions = {
        httpOnly: config.cookieHttpOnly,
        maxAge: config.jwtExpirationSeconds,
        sameSite: config.cookieSameSite,
        secure: config.cookieSecure,
    };
    if (typeof config.cookieDomain === 'string') {
        cookieOptions.domain = config.cookieDomain;
    }
    if (typeof config.cookiePath === 'string') {
        cookieOptions.path = config.cookiePath;
    }

    return cookieOptions;
}

function buildCsrfCookieOptions(config: AppConfig): CookieSerializeOptions {
    const cookieOptions: CookieSerializeOptions = {
        httpOnly: true,
        path: '/',
        sameSite: 'strict',
        secure: config.cookieSecure,
    };
    if (typeof config.cookieDomain === 'string') {
        cookieOptions.domain = config.cookieDomain;
    }

    return cookieOptions;
}

function verifyEmailTokenCookieName(config: AppConfig): string {
    return `${config.cookieName}.verify-email-token`;
}

function buildVerifyEmailTokenCookieOptions(config: AppConfig): CookieSerializeOptions {
    const cookieOptions: CookieSerializeOptions = {
        httpOnly: true,
        maxAge: config.emailExpirationSeconds,
        path: '/verify-email',
        sameSite: 'strict',
        secure: config.cookieSecure,
    };
    if (typeof config.cookieDomain === 'string') {
        cookieOptions.domain = config.cookieDomain;
    }

    return cookieOptions;
}

function setVerifyEmailTokenCookie(reply: FastifyReply, config: AppConfig, token: string): void {
    reply.setCookie(
        verifyEmailTokenCookieName(config),
        token,
        buildVerifyEmailTokenCookieOptions(config),
    );
}

function clearVerifyEmailTokenCookie(reply: FastifyReply, config: AppConfig): void {
    reply.clearCookie(
        verifyEmailTokenCookieName(config),
        buildVerifyEmailTokenCookieOptions(config),
    );
}

function buildContentSecurityPolicy(nonce: string): string {
    return [
        "default-src 'self'",
        "base-uri 'none'",
        "form-action 'self'",
        "frame-ancestors 'none'",
        "img-src 'self' data: https: http:",
        "object-src 'none'",
        `script-src 'self' 'nonce-${nonce}'`,
        `style-src 'self' 'nonce-${nonce}'`,
    ].join('; ');
}

function createCspNonce(): string {
    return randomBytes(16).toString('base64url');
}

function csrfCookieName(config: AppConfig): string {
    return `${config.cookieName}.csrf`;
}

function createCsrfToken(config: AppConfig): string {
    const nonce = randomBytes(32).toString('base64url');
    const signature = createHmac('sha256', config.csrfSecret).update(nonce).digest('base64url');
    return `${nonce}.${signature}`;
}

function safeCompare(left: string, right: string): boolean {
    const leftBuffer = Buffer.from(left);
    const rightBuffer = Buffer.from(right);
    if (leftBuffer.length !== rightBuffer.length) {
        return false;
    }

    return timingSafeEqual(leftBuffer, rightBuffer);
}

function isValidCsrfToken(token: string, config: AppConfig): boolean {
    const [nonce, signature, ...rest] = token.split('.');
    if (
        typeof nonce !== 'string' ||
        nonce.length === 0 ||
        typeof signature !== 'string' ||
        signature.length === 0 ||
        rest.length > 0
    ) {
        return false;
    }

    const expectedSignature = createHmac('sha256', config.csrfSecret)
        .update(nonce)
        .digest('base64url');
    return safeCompare(signature, expectedSignature);
}

function readSubmittedField(body: unknown, fieldName: string): string | undefined {
    if (typeof body !== 'object' || body === null || !(fieldName in body)) {
        return undefined;
    }

    const value = Reflect.get(body, fieldName);
    return typeof value === 'string' ? value : undefined;
}

function applyDefaultSecurityHeaders(request: FastifyRequest, reply: FastifyReply): void {
    reply.removeHeader('Server');
    reply.header(
        'Permissions-Policy',
        'camera=(), geolocation=(), microphone=(), payment=(), usb=()',
    );
    reply.header('Referrer-Policy', 'no-referrer');
    reply.header('X-Content-Type-Options', 'nosniff');
    reply.header('X-Frame-Options', 'DENY');
    reply.header('X-Permitted-Cross-Domain-Policies', 'none');

    if (request.protocol === 'https') {
        reply.header('Strict-Transport-Security', 'max-age=15552000; includeSubDomains');
    }
}

function setNoStoreHeaders(reply: FastifyReply): void {
    reply.header('Cache-Control', 'no-store');
    reply.header('Pragma', 'no-cache');
}

function sendInternalServerError(reply: FastifyReply, request: FastifyRequest): void {
    setNoStoreHeaders(reply);
    reply.code(500);

    if (expectsJsonResponse(request)) {
        reply.send({ message: 'Internal Server Error' });
        return;
    }

    reply.type('text/html; charset=utf-8');
    reply.send(`<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>Internal Server Error | Magic Link SSO</title>
  </head>
  <body>
    <main>
      <h1>Internal Server Error</h1>
      <p>Something went wrong.</p>
    </main>
  </body>
</html>`);
}

function createHtmlSecurityContext(
    reply: FastifyReply,
    config: AppConfig,
    options: {
        includeCsrfToken: boolean;
    },
): HtmlSecurityContext {
    const cspNonce = createCspNonce();
    reply.header('Content-Security-Policy', buildContentSecurityPolicy(cspNonce));

    if (!options.includeCsrfToken) {
        return {
            cspNonce,
            csrfToken: null,
        };
    }

    const csrfToken = createCsrfToken(config);
    reply.setCookie(csrfCookieName(config), csrfToken, buildCsrfCookieOptions(config));
    return {
        cspNonce,
        csrfToken,
    };
}

function hasValidHtmlCsrfToken(request: FastifyRequest, config: AppConfig): boolean {
    const submittedToken = readSubmittedField(request.body, 'csrfToken');
    const cookieToken = request.cookies[csrfCookieName(config)];
    if (typeof submittedToken !== 'string' || typeof cookieToken !== 'string') {
        return false;
    }

    return safeCompare(submittedToken, cookieToken) && isValidCsrfToken(submittedToken, config);
}

type HostedAuthFeedbackKey = keyof AppConfig['hostedAuthPageCopy']['feedback'];

const defaultHostedAuthFeedback = createDefaultHostedAuthPageCopy().feedback;

function getDefaultFeedbackMessage(key: HostedAuthFeedbackKey): string {
    return defaultHostedAuthFeedback[key];
}

function hasValidVerifyEmailPreviewSecret(request: FastifyRequest, config: AppConfig): boolean {
    const previewSecret = request.headers[verifyEmailPreviewSecretHeaderName];
    return (
        typeof previewSecret === 'string' &&
        previewSecret.length > 0 &&
        safeCompare(previewSecret, config.previewSecret)
    );
}

function getHostedAuthFeedbackMessage(
    viewConfig: HostedAuthViewConfig,
    key: HostedAuthFeedbackKey,
): string {
    return viewConfig.hostedAuthPageCopy.feedback[key];
}

function setRetryAfterHeader(reply: FastifyReply, retryAfterSeconds: number): void {
    reply.header('Retry-After', String(Math.max(1, retryAfterSeconds)));
}

async function respondWithVerificationEmailSent(
    reply: FastifyReply,
    options: {
        isJson: boolean;
        scope: string;
        site: HostedAuthViewConfig;
        returnUrl: string;
        verifyUrl: string;
        config: AppConfig;
    },
): Promise<void> {
    if (options.isJson) {
        reply.send({ message: getDefaultFeedbackMessage('verificationEmailSent') });
        return;
    }

    await renderSigninPage(
        reply,
        options.site,
        createHtmlSecurityContext(reply, options.config, {
            includeCsrfToken: true,
        }),
        {
            returnUrl: options.returnUrl,
            scope: options.scope,
            verifyUrl: options.verifyUrl,
            message: false,
            mode: 'confirmation',
            error: false,
        },
    );
}

async function respondWithTooManyRequests(
    reply: FastifyReply,
    options: {
        config: AppConfig;
        isJson: boolean;
        retryAfterSeconds: number;
        scope: string;
        site: HostedAuthViewConfig;
        returnUrl: string;
        verifyUrl: string;
    },
): Promise<void> {
    setRetryAfterHeader(reply, options.retryAfterSeconds);

    if (options.isJson) {
        reply.code(429).send({ message: getDefaultFeedbackMessage('tooManyRequests') });
        return;
    }

    await renderSigninPage(
        reply,
        options.site,
        createHtmlSecurityContext(reply, options.config, {
            includeCsrfToken: true,
        }),
        {
            error: getHostedAuthFeedbackMessage(options.site, 'tooManyRequests'),
            message: false,
            returnUrl: options.returnUrl,
            scope: options.scope,
            statusCode: 429,
            verifyUrl: options.verifyUrl,
        },
    );
}

type VerificationValidationResult =
    | {
          email: string;
          expiresAt: number;
          jti: string;
          ok: true;
          scope: string;
          safeReturnUrl: string | undefined;
          site: SiteConfig;
      }
    | {
          messageKey: 'invalidOrExpiredToken' | 'invalidOrUntrustedReturnUrl';
          ok: false;
          site: SiteConfig | undefined;
      };

async function validateVerificationToken(
    token: string,
    config: AppConfig,
    logger?: FastifyBaseLogger,
): Promise<VerificationValidationResult> {
    const payload = await verifyEmailToken(token, config.emailSecret, {
        expectedIssuer: getAppOrigin(config),
        onError: (failure) => {
            logger?.info(
                {
                    jwtError: failure.errorName,
                },
                'Rejected verification token',
            );
        },
    });
    if (!payload || typeof payload.exp !== 'number') {
        return {
            ok: false,
            messageKey: 'invalidOrExpiredToken',
            site: undefined,
        };
    }

    const site = findSiteById(config, payload.siteId);
    if (typeof site === 'undefined') {
        return {
            ok: false,
            messageKey: 'invalidOrExpiredToken',
            site: undefined,
        };
    }

    if (!audienceIncludes(payload.aud, site.id)) {
        return {
            ok: false,
            messageKey: 'invalidOrExpiredToken',
            site: undefined,
        };
    }

    const safeReturnUrl = normaliseRedirectUrlForSite(payload.returnUrl, site);
    if (safeReturnUrl === null) {
        return {
            ok: false,
            messageKey: 'invalidOrUntrustedReturnUrl',
            site,
        };
    }

    return {
        ok: true,
        email: payload.email,
        expiresAt: payload.exp * 1000,
        jti: payload.jti,
        scope: payload.scope,
        safeReturnUrl,
        site,
    };
}

type SignInResolutionResult =
    | {
          ok: true;
          safeReturnUrl: string | undefined;
          safeVerifyUrl: string;
          site: SiteConfig;
      }
    | {
          messageKey:
              | 'invalidRequest'
              | 'invalidOrUntrustedReturnUrl'
              | 'invalidOrUntrustedVerifyUrl';
          ok: false;
      };

function resolveSignInRequest(
    config: AppConfig,
    options: {
        returnUrl?: string | undefined;
        verifyUrl?: string | undefined;
    },
): SignInResolutionResult {
    let site: SiteConfig | undefined;
    let safeReturnUrl: string | undefined;

    if (typeof options.returnUrl === 'string') {
        const parsedReturnUrl = parseTrustedAbsoluteUrl(options.returnUrl);
        if (parsedReturnUrl === null) {
            return {
                ok: false,
                messageKey: 'invalidOrUntrustedReturnUrl',
            };
        }

        site = findSiteByOrigin(config, parsedReturnUrl.origin);
        if (typeof site === 'undefined') {
            return {
                ok: false,
                messageKey: 'invalidOrUntrustedReturnUrl',
            };
        }

        const normalisedReturnUrl = normaliseRedirectUrlForSite(options.returnUrl, site);
        if (typeof normalisedReturnUrl !== 'string') {
            return {
                ok: false,
                messageKey: 'invalidOrUntrustedReturnUrl',
            };
        }

        safeReturnUrl = normalisedReturnUrl;
    }

    if (typeof options.verifyUrl === 'string') {
        let verifySite = site;
        if (typeof verifySite === 'undefined') {
            const parsedVerifyUrl = parseTrustedAbsoluteUrl(options.verifyUrl);
            if (parsedVerifyUrl === null) {
                return {
                    ok: false,
                    messageKey: 'invalidOrUntrustedVerifyUrl',
                };
            }

            verifySite = findSiteByOrigin(config, parsedVerifyUrl.origin);
        }

        if (typeof verifySite === 'undefined') {
            return {
                ok: false,
                messageKey: 'invalidOrUntrustedVerifyUrl',
            };
        }

        const normalisedVerifyUrl = normaliseRedirectUrlForSite(options.verifyUrl, verifySite);
        if (typeof normalisedVerifyUrl !== 'string') {
            return {
                ok: false,
                messageKey: 'invalidOrUntrustedVerifyUrl',
            };
        }

        site = verifySite;

        return {
            ok: true,
            safeReturnUrl,
            safeVerifyUrl: normalisedVerifyUrl,
            site,
        };
    }

    if (typeof site === 'undefined') {
        return {
            ok: false,
            messageKey: 'invalidRequest',
        };
    }

    return {
        ok: true,
        safeReturnUrl,
        safeVerifyUrl: options.verifyUrl ?? defaultVerifyUrl(config),
        site,
    };
}

async function completeEmailVerification(
    reply: FastifyReply,
    options: {
        config: AppConfig;
        isJson: boolean;
        logger?: FastifyBaseLogger;
        token: string;
        verificationTokenReplayStore: VerificationTokenReplayStore;
    },
): Promise<void> {
    const validation = await validateVerificationToken(
        options.token,
        options.config,
        options.logger,
    );
    if (!validation.ok) {
        if (options.isJson) {
            reply.code(400).send({ message: getDefaultFeedbackMessage(validation.messageKey) });
            return;
        }

        await renderVerifyEmailPage(
            reply,
            validation.site ?? options.config,
            createHtmlSecurityContext(reply, options.config, {
                includeCsrfToken: false,
            }),
            {
                email: null,
                error: getHostedAuthFeedbackMessage(
                    validation.site ?? options.config,
                    validation.messageKey,
                ),
                statusCode: 400,
            },
        );
        return;
    }

    const consumed = await options.verificationTokenReplayStore.consume(
        validation.jti,
        validation.expiresAt,
    );
    if (!consumed) {
        if (options.isJson) {
            reply.code(400).send({ message: getDefaultFeedbackMessage('invalidOrExpiredToken') });
            return;
        }

        await renderVerifyEmailPage(
            reply,
            validation.site,
            createHtmlSecurityContext(reply, options.config, {
                includeCsrfToken: false,
            }),
            {
                email: null,
                error: getHostedAuthFeedbackMessage(validation.site, 'invalidOrExpiredToken'),
                statusCode: 400,
            },
        );
        return;
    }

    const accessToken = await signAccessToken(
        validation.email,
        validation.scope,
        validation.site.id,
        [...validation.site.origins].sort(),
        getAppOrigin(options.config),
        options.config.jwtSecret,
        options.config.jwtExpirationSeconds,
    );

    if (options.isJson) {
        setNoStoreHeaders(reply);
        reply.send({ accessToken });
        return;
    }

    reply
        .header('Cache-Control', 'no-store')
        .header('Pragma', 'no-cache')
        .setCookie(options.config.cookieName, accessToken, buildAuthCookieOptions(options.config))
        .redirect(validation.safeReturnUrl ?? '/');
}

export async function buildApp(options: BuildAppOptions = {}): Promise<FastifyInstance> {
    const config = options.config ?? loadConfig();
    const mailer = options.mailer ?? createVerificationEmailSender(config);
    const securityState = options.securityState ?? (await createSecurityState(config));
    const verificationTokenReplayStore =
        options.verificationTokenReplayStore ?? securityState.verificationTokenReplayStore;
    const perEmailSignInLimiter =
        options.perEmailSignInLimiter ?? securityState.perEmailSignInLimiter;
    const sessionRevocationStore =
        options.sessionRevocationStore ?? securityState.sessionRevocationStore;

    const app = Fastify({
        trustProxy: config.trustProxy,
        logger: options.logger ?? createLoggerOptions(config),
    });

    app.addHook('onClose', async (): Promise<void> => {
        await securityState.close();
    });

    await app.register(cookie);
    await app.register(formbody);
    await app.register(rateLimit, {
        global: false,
    });
    await app.register(view, {
        engine: {
            ejs,
        },
        root: fileURLToPath(new URL('../src/views/', import.meta.url)),
    });
    app.setErrorHandler((error, request, reply): void => {
        const statusCode = getErrorStatusCode(error);
        if (typeof statusCode === 'number' && statusCode < 500) {
            reply.code(statusCode);
            reply.send({
                message:
                    statusCode === 429
                        ? 'Too many requests.'
                        : (getErrorMessage(error) ?? 'Bad Request'),
            });
            return;
        }

        request.log.error({ err: error }, 'Unhandled server error');
        if (reply.sent) {
            return;
        }

        sendInternalServerError(reply, request);
    });
    app.addHook('onSend', async (request, reply, payload): Promise<unknown> => {
        applyDefaultSecurityHeaders(request, reply);
        return payload;
    });

    app.get('/', async (_request, reply): Promise<void> => {
        if (!config.serveRootLandingPage) {
            await reply.callNotFound();
            return;
        }

        await renderLandingPage(
            reply,
            config,
            createHtmlSecurityContext(reply, config, {
                includeCsrfToken: false,
            }),
        );
    });

    app.get('/robots.txt', async (_request, reply): Promise<void> => {
        reply
            .type('text/plain; charset=utf-8')
            .header('Cache-Control', 'no-store')
            .send('User-agent: *\nDisallow: /\n');
    });

    app.get(
        '/healthz',
        {
            config: {
                rateLimit: {
                    max: config.healthzRateLimitMax,
                    timeWindow: config.rateLimitWindowMs,
                },
            },
        },
        async (_request, reply): Promise<void> => {
            if (typeof options.startupProbeToken === 'string') {
                reply.header(getStartupProbeHeaderName(), options.startupProbeToken);
            }
            reply.send({ status: 'ok' });
        },
    );

    app.post('/session-revocations/check', async (request, reply): Promise<void> => {
        setNoStoreHeaders(reply);
        if (!hasValidVerifyEmailPreviewSecret(request, config)) {
            reply.code(403).send({ message: 'Forbidden' });
            return;
        }

        const parsedBody = sessionRevocationCheckBodySchema.safeParse(request.body);
        if (!parsedBody.success) {
            reply.code(400).send({ message: 'Invalid request' });
            return;
        }

        reply.send({
            revoked: await sessionRevocationStore.isRevoked(parsedBody.data.jti),
        });
    });

    app.get<{ Querystring: SignInQuerystring }>(
        '/signin',
        {
            config: {
                rateLimit: {
                    max: config.signInPageRateLimitMax,
                    timeWindow: config.rateLimitWindowMs,
                },
            },
        },
        async (request, reply): Promise<void> => {
            const parsedQuery = signInQuerySchema.safeParse(request.query);
            if (!parsedQuery.success) {
                request.log.info(
                    {
                        issues: parsedQuery.error.issues,
                    },
                    'Rejected invalid hosted sign-in page request',
                );
                await renderSigninPage(
                    reply,
                    config,
                    createHtmlSecurityContext(reply, config, {
                        includeCsrfToken: true,
                    }),
                    {
                        returnUrl: '',
                        scope: '',
                        verifyUrl: '',
                        message: false,
                        error: getHostedAuthFeedbackMessage(config, 'invalidRequest'),
                        statusCode: 400,
                    },
                );
                return;
            }

            const resolvedRequest = resolveSignInRequest(config, parsedQuery.data);
            if (!resolvedRequest.ok) {
                request.log.info(
                    {
                        messageKey: resolvedRequest.messageKey,
                        returnUrl: parsedQuery.data.returnUrl,
                        verifyUrl: parsedQuery.data.verifyUrl,
                    },
                    'Rejected hosted sign-in page request',
                );
                await renderSigninPage(
                    reply,
                    config,
                    createHtmlSecurityContext(reply, config, {
                        includeCsrfToken: true,
                    }),
                    {
                        returnUrl: parsedQuery.data.returnUrl ?? '',
                        scope: normalizeRequestedScope(parsedQuery.data.scope),
                        verifyUrl: parsedQuery.data.verifyUrl ?? '',
                        message: false,
                        error: getHostedAuthFeedbackMessage(config, resolvedRequest.messageKey),
                        statusCode: 400,
                    },
                );
                return;
            }

            await renderSigninPage(
                reply,
                resolvedRequest.site,
                createHtmlSecurityContext(reply, config, {
                    includeCsrfToken: true,
                }),
                {
                    returnUrl: resolvedRequest.safeReturnUrl ?? '',
                    scope: normalizeRequestedScope(parsedQuery.data.scope),
                    verifyUrl:
                        resolvedRequest.safeVerifyUrl === defaultVerifyUrl(config)
                            ? ''
                            : resolvedRequest.safeVerifyUrl,
                    message: false,
                    error: false,
                },
            );
        },
    );

    app.post<{ Body: unknown }>(
        '/signin',
        {
            config: {
                rateLimit: {
                    max: config.signInRateLimitMax,
                    timeWindow: config.rateLimitWindowMs,
                },
            },
        },
        async (request, reply): Promise<void> => {
            const isJson = expectsJsonResponse(request);
            if (
                !hasSafeApiContentType(request, config) &&
                !hasValidHtmlCsrfToken(request, config)
            ) {
                request.log.info('Rejected sign-in form request with invalid CSRF token');
                if (isJson) {
                    reply.code(403).send({ message: 'Invalid or missing CSRF token' });
                    return;
                }
                await renderSigninPage(
                    reply,
                    config,
                    createHtmlSecurityContext(reply, config, {
                        includeCsrfToken: true,
                    }),
                    {
                        returnUrl: '',
                        scope: normalizeRequestedScope(readSubmittedField(request.body, 'scope')),
                        verifyUrl: '',
                        message: false,
                        error: getHostedAuthFeedbackMessage(config, 'invalidRequest'),
                        statusCode: 403,
                    },
                );
                return;
            }

            const parsedBody = signInBodySchema.safeParse(request.body);

            if (!parsedBody.success) {
                request.log.info(
                    { issues: parsedBody.error.issues },
                    'Rejected invalid sign-in request',
                );

                if (isJson) {
                    reply.code(400).send({ message: 'Invalid request' });
                    return;
                }

                await renderSigninPage(
                    reply,
                    config,
                    createHtmlSecurityContext(reply, config, {
                        includeCsrfToken: true,
                    }),
                    {
                        returnUrl: '',
                        scope: normalizeRequestedScope(readSubmittedField(request.body, 'scope')),
                        verifyUrl: '',
                        message: false,
                        error: getHostedAuthFeedbackMessage(config, 'invalidRequest'),
                        statusCode: 400,
                    },
                );
                return;
            }

            const { email, returnUrl, scope, verifyUrl } = parsedBody.data;
            const requestedScope = normalizeRequestedScope(scope);
            const resolvedRequest = resolveSignInRequest(config, {
                returnUrl,
                verifyUrl,
            });
            if (!resolvedRequest.ok) {
                logRejectedSignIn(config, request, {
                    email,
                    messageKey: resolvedRequest.messageKey,
                    returnUrl,
                    scope: requestedScope,
                    verifyUrl,
                });
                if (isJson) {
                    reply
                        .code(400)
                        .send({ message: getDefaultFeedbackMessage(resolvedRequest.messageKey) });
                    return;
                }

                await renderSigninPage(
                    reply,
                    config,
                    createHtmlSecurityContext(reply, config, {
                        includeCsrfToken: true,
                    }),
                    {
                        returnUrl: returnUrl ?? '',
                        scope: requestedScope,
                        verifyUrl: verifyUrl ?? '',
                        message: false,
                        error: getHostedAuthFeedbackMessage(config, resolvedRequest.messageKey),
                        statusCode: 400,
                    },
                );
                return;
            }

            const perEmailLimit = await perEmailSignInLimiter.consume(email, request.ip);
            if (!perEmailLimit.allowed) {
                request.log.warn(
                    {
                        emailDomain: extractEmailDomain(email),
                        emailHash: hashEmailForLogs(config, email),
                        retryAfterSeconds: perEmailLimit.retryAfterSeconds,
                    },
                    'Rejected sign-in request due to per-email rate limit',
                );
                await respondWithTooManyRequests(reply, {
                    config,
                    isJson,
                    retryAfterSeconds: perEmailLimit.retryAfterSeconds,
                    returnUrl: resolvedRequest.safeReturnUrl ?? '',
                    scope: requestedScope,
                    site: resolvedRequest.site,
                    verifyUrl: verifyUrl ?? '',
                });
                return;
            }

            if (!siteAllows(resolvedRequest.site, email, requestedScope)) {
                logRejectedSignIn(config, request, {
                    email,
                    messageKey: 'forbidden',
                    returnUrl,
                    scope: requestedScope,
                    verifyUrl,
                });

                await respondWithVerificationEmailSent(reply, {
                    config,
                    isJson,
                    returnUrl: resolvedRequest.safeReturnUrl ?? '',
                    scope: requestedScope,
                    site: resolvedRequest.site,
                    verifyUrl: verifyUrl ?? '',
                });
                return;
            }

            const token = await generateEmailToken(
                email,
                resolvedRequest.safeReturnUrl,
                resolvedRequest.site.id,
                requestedScope,
                getAppOrigin(config),
                config.emailSecret,
                config.emailExpirationSeconds,
            );

            try {
                await mailer.sendVerificationEmail({
                    email,
                    siteTitle:
                        resolvedRequest.site.hostedAuthBranding.title ||
                        config.hostedAuthBranding.title,
                    token,
                    verifyUrl: resolvedRequest.safeVerifyUrl,
                });
            } catch (error) {
                request.log.error(
                    {
                        err: error,
                    },
                    'Failed to send verification email',
                );

                if (isJson) {
                    reply.code(500).send({ message: 'Failed to send email' });
                    return;
                }

                await renderSigninPage(
                    reply,
                    config,
                    createHtmlSecurityContext(reply, config, {
                        includeCsrfToken: true,
                    }),
                    {
                        returnUrl: resolvedRequest.safeReturnUrl ?? '',
                        scope: requestedScope,
                        verifyUrl: verifyUrl ?? '',
                        message: false,
                        error: getHostedAuthFeedbackMessage(config, 'failedToSendEmail'),
                        statusCode: 500,
                    },
                );
                return;
            }

            await respondWithVerificationEmailSent(reply, {
                config,
                isJson,
                returnUrl: resolvedRequest.safeReturnUrl ?? '',
                scope: requestedScope,
                site: resolvedRequest.site,
                verifyUrl: verifyUrl ?? '',
            });
        },
    );

    app.get<{ Querystring: unknown }>(
        '/verify-email',
        {
            config: {
                rateLimit: {
                    max: config.verifyRateLimitMax,
                    timeWindow: config.rateLimitWindowMs,
                },
            },
        },
        async (request, reply): Promise<void> => {
            const isJson = expectsJsonResponse(request);
            if (isJson) {
                setNoStoreHeaders(reply);
            }
            const parsedQuery = verifyEmailQuerySchema.safeParse(request.query);

            if (!parsedQuery.success) {
                clearVerifyEmailTokenCookie(reply, config);
                if (isJson) {
                    reply
                        .code(400)
                        .send({ message: getDefaultFeedbackMessage('invalidOrExpiredToken') });
                    return;
                }

                await renderVerifyEmailPage(
                    reply,
                    config,
                    createHtmlSecurityContext(reply, config, {
                        includeCsrfToken: false,
                    }),
                    {
                        email: null,
                        error: getHostedAuthFeedbackMessage(config, 'invalidOrExpiredToken'),
                        statusCode: 400,
                    },
                );
                return;
            }

            if (isJson && !hasValidVerifyEmailPreviewSecret(request, config)) {
                reply.code(403).send({ message: getDefaultFeedbackMessage('forbidden') });
                return;
            }

            const validation = await validateVerificationToken(
                parsedQuery.data.token,
                config,
                request.log,
            );
            if (isJson) {
                if (!validation.ok) {
                    clearVerifyEmailTokenCookie(reply, config);
                    reply
                        .code(400)
                        .send({ message: getDefaultFeedbackMessage(validation.messageKey) });
                    return;
                }

                reply.send({ email: validation.email });
                return;
            }

            setVerifyEmailTokenCookie(reply, config, parsedQuery.data.token);

            if (!validation.ok) {
                clearVerifyEmailTokenCookie(reply, config);
                await renderVerifyEmailPage(
                    reply,
                    validation.site ?? config,
                    createHtmlSecurityContext(reply, config, {
                        includeCsrfToken: false,
                    }),
                    {
                        email: null,
                        error: getHostedAuthFeedbackMessage(
                            validation.site ?? config,
                            validation.messageKey,
                        ),
                        statusCode: 400,
                    },
                );
                return;
            }

            await renderVerifyEmailPage(
                reply,
                validation.site,
                createHtmlSecurityContext(reply, config, {
                    includeCsrfToken: true,
                }),
                {
                    email: validation.email,
                    error: false,
                },
            );
        },
    );

    app.post<{ Body: unknown }>(
        '/verify-email',
        {
            config: {
                rateLimit: {
                    max: config.verifyRateLimitMax,
                    timeWindow: config.rateLimitWindowMs,
                },
            },
        },
        async (request, reply): Promise<void> => {
            const isJson = expectsJsonResponse(request);
            if (isJson) {
                setNoStoreHeaders(reply);
            }
            if (
                !hasSafeApiContentType(request, config) &&
                !hasValidHtmlCsrfToken(request, config)
            ) {
                request.log.info('Rejected verify-email form request with invalid CSRF token');
                clearVerifyEmailTokenCookie(reply, config);
                if (isJson) {
                    reply.code(403).send({ message: 'Invalid or missing CSRF token' });
                    return;
                }
                await renderVerifyEmailPage(
                    reply,
                    config,
                    createHtmlSecurityContext(reply, config, {
                        includeCsrfToken: false,
                    }),
                    {
                        email: null,
                        error: getHostedAuthFeedbackMessage(config, 'invalidRequest'),
                        statusCode: 403,
                    },
                );
                return;
            }

            const parsedBody = verifyEmailBodySchema.safeParse(request.body);
            const submittedToken = parsedBody.success
                ? (parsedBody.data.token ?? request.cookies[verifyEmailTokenCookieName(config)])
                : undefined;

            clearVerifyEmailTokenCookie(reply, config);

            if (
                !parsedBody.success ||
                typeof submittedToken !== 'string' ||
                submittedToken.length === 0
            ) {
                if (isJson) {
                    reply
                        .code(400)
                        .send({ message: getDefaultFeedbackMessage('invalidOrExpiredToken') });
                    return;
                }

                await renderVerifyEmailPage(
                    reply,
                    config,
                    createHtmlSecurityContext(reply, config, {
                        includeCsrfToken: false,
                    }),
                    {
                        email: null,
                        error: getHostedAuthFeedbackMessage(config, 'invalidOrExpiredToken'),
                        statusCode: 400,
                    },
                );
                return;
            }

            await completeEmailVerification(reply, {
                config,
                isJson,
                logger: request.log,
                token: submittedToken,
                verificationTokenReplayStore,
            });
        },
    );

    app.post('/logout', async (request, reply): Promise<void> => {
        setNoStoreHeaders(reply);
        if (!hasSameOriginMutationSource(request, config)) {
            reply.code(403).send({ message: 'Forbidden' });
            return;
        }

        await revokeRequestAccessToken({
            config,
            request,
            sessionRevocationStore,
        });
        reply.clearCookie(config.cookieName, buildAuthCookieOptions(config));

        if (expectsJsonResponse(request)) {
            reply.send({ message: 'Signed out' });
            return;
        }

        reply.redirect('/');
    });

    return app;
}
