/**
 * server/src/app.test.ts
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

import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PassThrough } from 'node:stream';
import type { FastifyInstance } from 'fastify';
import type { FastifyServerOptions } from 'fastify';
import { SignJWT } from 'jose';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { z } from 'zod';
import {
    createDefaultHostedAuthBranding,
    createDefaultHostedAuthPageCopy,
    type AppConfig,
    type RedirectUriRule,
} from './config.js';
import {
    generateEmailToken as generateVerificationToken,
    signAccessToken,
    verifyAccessToken,
    verifyEmailToken,
} from './auth.js';
import { buildApp } from './app.js';
import type { VerificationEmailInput, VerificationEmailSender } from './email.js';
import { FULL_ACCESS_SCOPE } from './scope.js';
import type { SessionRevocationStore } from './sessionRevocationStore.js';
import type { VerificationTokenReplayStore } from './verificationTokenReplayStore.js';

const verificationIssuer = 'http://sso.example.com';
const previewSecret = 'preview-secret-for-magic-sso-123456';

function createAccessRules(entries: Record<string, string[]>): Map<string, Set<string>> {
    return new Map(Object.entries(entries).map(([email, scopes]) => [email, new Set(scopes)]));
}

function createAllowedRedirectUris(entries: string[]): RedirectUriRule[] {
    return entries.map((entry) => {
        const isSubpathRule = entry.endsWith('/*');
        const parsedUrl = new URL(isSubpathRule ? entry.slice(0, -1) : entry);

        return {
            match: isSubpathRule ? 'subpath' : 'exact',
            origin: parsedUrl.origin,
            pathname: parsedUrl.pathname,
        };
    });
}

function createTestConfig(): AppConfig {
    const hostedAuthBranding = createDefaultHostedAuthBranding();
    const hostedAuthPageCopy = createDefaultHostedAuthPageCopy();

    return {
        appPort: 3000,
        appUrl: 'http://sso.example.com',
        csrfSecret: 'csrf-secret',
        cookieDomain: undefined,
        cookieHttpOnly: true,
        cookieName: 'magic-sso',
        cookiePath: undefined,
        cookieSameSite: 'lax',
        cookieSecure: false,
        emailExpirationSeconds: 15 * 60,
        emailFrom: 'owner@example.com',
        emailSecret: 'email-secret',
        emailSignature: 'Magic Link SSO',
        emailSmtpHost: 'smtp.example.com',
        emailSmtpPort: 587,
        emailSmtpPass: 'smtp-password',
        emailSmtpSecure: false,
        emailSmtpUser: 'smtp-user',
        emailSmtpFallbacks: [],
        hostedAuthBranding,
        hostedAuthPageCopy,
        healthzRateLimitMax: 60,
        logFormat: 'json',
        jwtExpirationSeconds: 60 * 60,
        jwtSecret: 'jwt-secret',
        logLevel: 'info',
        rateLimitWindowMs: 60_000,
        previewSecret,
        securityState: {
            adapter: 'file',
            keyPrefix: 'magic-sso-test',
            redisUrl: undefined,
        },
        serveRootLandingPage: true,
        signInEmailRateLimitMax: 5,
        signInEmailRateLimitStoreDir: '.magic-sso/test-signin-email-rate-limit',
        signInPageRateLimitMax: 30,
        signInRateLimitMax: 20,
        sites: [
            {
                id: 'client',
                origins: new Set(['http://client.example.com']),
                allowedRedirectUris: createAllowedRedirectUris(['http://client.example.com/*']),
                accessRules: createAccessRules({
                    'allowed@example.com': [FULL_ACCESS_SCOPE],
                }),
                hostedAuthBranding,
                hostedAuthPageCopy,
            },
        ],
        trustProxy: false,
        verifyRateLimitMax: 40,
        verifyTokenStoreDir: '.magic-sso/test-verification-tokens',
    };
}

async function generateEmailToken(
    email: string,
    returnUrl: string | undefined,
    siteId: string,
    scope: string,
    secret: string,
    expiresInSeconds: number,
): Promise<string> {
    return generateVerificationToken(
        email,
        returnUrl,
        siteId,
        scope,
        verificationIssuer,
        secret,
        expiresInSeconds,
    );
}

async function generateEmailTokenWithAudience(
    email: string,
    returnUrl: string | undefined,
    siteId: string,
    scope: string,
    audience: string | string[],
    secret: string,
    expiresInSeconds: number,
): Promise<string> {
    return new SignJWT({
        email,
        jti: 'array-audience-jti',
        scope,
        siteId,
        ...(typeof returnUrl === 'string' ? { returnUrl } : {}),
    })
        .setProtectedHeader({ alg: 'HS256' })
        .setIssuedAt()
        .setAudience(audience)
        .setExpirationTime(`${expiresInSeconds}s`)
        .setIssuer(verificationIssuer)
        .sign(new TextEncoder().encode(secret));
}

function getSetCookieHeaders(appResponse: {
    headers: Record<string, string | string[] | number | undefined>;
}): string[] {
    const header = appResponse.headers['set-cookie'];
    if (typeof header === 'string') {
        return [header];
    }
    if (Array.isArray(header)) {
        return header.filter((value): value is string => typeof value === 'string');
    }

    return [];
}

function getCookieHeader(appResponse: {
    headers: Record<string, string | string[] | number | undefined>;
}): string {
    return getSetCookieHeaders(appResponse)
        .map((cookie) => cookie.split(';', 1)[0] ?? '')
        .filter((cookie) => cookie.length > 0)
        .join('; ');
}

function extractHiddenInputValue(body: string, fieldName: string): string {
    const escapedFieldName = fieldName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const match = body.match(new RegExp(`name="${escapedFieldName}" value="([^"]+)"`));
    if (match?.[1]) {
        return match[1];
    }

    throw new Error(`Expected hidden input ${fieldName} in HTML response.`);
}

function extractLinkHref(body: string, className: string): string {
    const escapedClassName = className.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const match = body.match(new RegExp(`class="${escapedClassName}" href="([^"]+)"`));
    if (match?.[1]) {
        return match[1].replaceAll('&amp;', '&');
    }

    throw new Error(`Expected link with class ${className} in HTML response.`);
}

async function getSigninFormSecurityContext(
    app: FastifyInstance,
    returnUrl = 'http://client.example.com/protected',
): Promise<{
    cookieHeader: string;
    csrfToken: string;
}> {
    const response = await app.inject({
        method: 'GET',
        url: `/signin?returnUrl=${encodeURIComponent(returnUrl)}`,
        headers: {
            accept: 'text/html',
        },
    });

    expect(response.statusCode).toBe(200);
    return {
        cookieHeader: getCookieHeader(response),
        csrfToken: extractHiddenInputValue(response.body, 'csrfToken'),
    };
}

async function getVerifyEmailFormSecurityContext(
    app: FastifyInstance,
    token: string,
): Promise<{
    cookieHeader: string;
    csrfToken: string;
    responseBody: string;
}> {
    const response = await app.inject({
        method: 'GET',
        url: `/verify-email?token=${encodeURIComponent(token)}`,
        headers: {
            accept: 'text/html',
        },
    });

    expect(response.statusCode).toBe(200);
    return {
        cookieHeader: getCookieHeader(response),
        csrfToken: extractHiddenInputValue(response.body, 'csrfToken'),
        responseBody: response.body,
    };
}

async function createTestApp(
    options: {
        config?: Partial<AppConfig>;
        logger?: FastifyServerOptions['logger'];
        mailer?: VerificationEmailSender;
        replayStore?: VerificationTokenReplayStore;
        sessionRevocationStore?: SessionRevocationStore;
        sentEmails?: VerificationEmailInput[];
        startupProbeToken?: string;
    } = {},
): Promise<FastifyInstance> {
    const baseConfig = createTestConfig();
    const createdVerifyTokenStoreDir =
        options.config?.verifyTokenStoreDir ??
        mkdtempSync(join(tmpdir(), 'magic-sso-verify-store-'));
    const createdSignInEmailRateLimitStoreDir =
        options.config?.signInEmailRateLimitStoreDir ??
        mkdtempSync(join(tmpdir(), 'magic-sso-email-limit-store-'));
    const config: AppConfig = {
        ...baseConfig,
        verifyTokenStoreDir: createdVerifyTokenStoreDir,
        signInEmailRateLimitStoreDir: createdSignInEmailRateLimitStoreDir,
        ...options.config,
        sites: options.config?.sites ?? baseConfig.sites,
    };
    if (
        typeof options.config?.hostedAuthBranding !== 'undefined' &&
        typeof options.config.sites === 'undefined'
    ) {
        config.sites = config.sites.map((site) => ({
            ...site,
            hostedAuthBranding: options.config?.hostedAuthBranding ?? site.hostedAuthBranding,
        }));
    }
    if (
        typeof options.config?.hostedAuthPageCopy !== 'undefined' &&
        typeof options.config.sites === 'undefined'
    ) {
        config.sites = config.sites.map((site) => ({
            ...site,
            hostedAuthPageCopy: options.config?.hostedAuthPageCopy ?? site.hostedAuthPageCopy,
        }));
    }
    const sentEmails = options.sentEmails ?? [];
    const mailer =
        options.mailer ??
        ({
            async sendVerificationEmail(input: VerificationEmailInput): Promise<void> {
                sentEmails.push(input);
            },
        } satisfies VerificationEmailSender);

    const buildAppOptions: Parameters<typeof buildApp>[0] = {
        config,
        logger: options.logger ?? false,
        mailer,
    };

    if (typeof options.replayStore !== 'undefined') {
        buildAppOptions.verificationTokenReplayStore = options.replayStore;
    }

    if (typeof options.sessionRevocationStore !== 'undefined') {
        buildAppOptions.sessionRevocationStore = options.sessionRevocationStore;
    }

    if (typeof options.startupProbeToken === 'string') {
        buildAppOptions.startupProbeToken = options.startupProbeToken;
    }

    const app = await buildApp(buildAppOptions);
    if (typeof options.config?.verifyTokenStoreDir === 'undefined') {
        app.addHook('onClose', async (): Promise<void> => {
            rmSync(createdVerifyTokenStoreDir, { recursive: true, force: true });
        });
    }
    if (typeof options.config?.signInEmailRateLimitStoreDir === 'undefined') {
        app.addHook('onClose', async (): Promise<void> => {
            rmSync(createdSignInEmailRateLimitStoreDir, { recursive: true, force: true });
        });
    }

    return app;
}

async function waitForLogFlush(): Promise<void> {
    await new Promise<void>((resolve) => {
        setImmediate(() => resolve());
    });
}

describe('buildApp', () => {
    let app: FastifyInstance;
    let sentEmails: VerificationEmailInput[];
    let config: AppConfig;
    let signInEmailRateLimitStoreDir: string;
    let verifyTokenStoreDir: string;

    beforeEach(async () => {
        signInEmailRateLimitStoreDir = mkdtempSync(join(tmpdir(), 'magic-sso-email-limit-store-'));
        verifyTokenStoreDir = mkdtempSync(join(tmpdir(), 'magic-sso-verify-store-'));
        config = {
            ...createTestConfig(),
            signInEmailRateLimitStoreDir,
            verifyTokenStoreDir,
        };
        sentEmails = [];

        const mailer: VerificationEmailSender = {
            async sendVerificationEmail(input: VerificationEmailInput): Promise<void> {
                sentEmails.push(input);
            },
        };

        app = await createTestApp({
            config,
            mailer,
        });
    });

    afterEach(async () => {
        await app.close();
        rmSync(signInEmailRateLimitStoreDir, { recursive: true, force: true });
        rmSync(verifyTokenStoreDir, { recursive: true, force: true });
    });

    it('returns a health response', async () => {
        const response = await app.inject({
            method: 'GET',
            url: '/healthz',
        });

        expect(response.statusCode).toBe(200);
        expect(response.json()).toEqual({ status: 'ok' });
    });

    it('includes the startup probe header on the health response when configured', async () => {
        const probeApp = await createTestApp({
            startupProbeToken: 'startup-probe-token',
        });

        try {
            const response = await probeApp.inject({
                method: 'GET',
                url: '/healthz',
            });

            expect(response.statusCode).toBe(200);
            expect(response.headers['x-magic-sso-startup-probe']).toBe('startup-probe-token');
        } finally {
            await probeApp.close();
        }
    });

    it('revokes the current cookie session on POST /logout', async () => {
        const revokedJtis: string[] = [];
        const sessionRevocationStore: SessionRevocationStore = {
            async isRevoked(): Promise<boolean> {
                return false;
            },
            async revoke(jti: string): Promise<void> {
                revokedJtis.push(jti);
            },
        };
        await app.close();
        app = await createTestApp({
            sessionRevocationStore,
        });
        const token = await signAccessToken(
            'allowed@example.com',
            FULL_ACCESS_SCOPE,
            'client',
            ['http://client.example.com'],
            'http://sso.example.com',
            'jwt-secret',
            300,
        );
        const payload = await verifyAccessToken(token, 'jwt-secret', {
            expectedIssuer: 'http://sso.example.com',
        });

        const response = await app.inject({
            method: 'POST',
            url: '/logout',
            headers: {
                accept: 'application/json',
                cookie: `magic-sso=${encodeURIComponent(token)}`,
                origin: 'http://sso.example.com',
            },
        });

        expect(response.statusCode).toBe(200);
        expect(response.json()).toEqual({ message: 'Signed out' });
        expect(revokedJtis).toEqual([payload?.jti]);
        expect(response.cookies.some((entry) => entry.name === 'magic-sso')).toBe(true);
    });

    it('reports revoked session ids only to callers with the preview secret', async () => {
        const sessionRevocationStore: SessionRevocationStore = {
            async isRevoked(jti: string): Promise<boolean> {
                return jti === 'revoked-session-jti';
            },
            async revoke(): Promise<void> {
                // No-op for this test.
            },
        };
        await app.close();
        app = await createTestApp({
            sessionRevocationStore,
        });

        const forbiddenResponse = await app.inject({
            method: 'POST',
            url: '/session-revocations/check',
            headers: {
                accept: 'application/json',
                'content-type': 'application/json',
            },
            payload: {
                jti: 'revoked-session-jti',
            },
        });

        const allowedResponse = await app.inject({
            method: 'POST',
            url: '/session-revocations/check',
            headers: {
                accept: 'application/json',
                'content-type': 'application/json',
                'x-magic-sso-preview-secret': previewSecret,
            },
            payload: {
                jti: 'revoked-session-jti',
            },
        });

        expect(forbiddenResponse.statusCode).toBe(403);
        expect(forbiddenResponse.json()).toEqual({ message: 'Forbidden' });
        expect(allowedResponse.statusCode).toBe(200);
        expect(allowedResponse.json()).toEqual({ revoked: true });
    });

    it('rejects cross-origin POST /logout requests', async () => {
        const response = await app.inject({
            method: 'POST',
            url: '/logout',
            headers: {
                accept: 'application/json',
                origin: 'https://attacker.example.com',
            },
        });

        expect(response.statusCode).toBe(403);
        expect(response.json()).toEqual({ message: 'Forbidden' });
    });

    it('rate limits the health endpoint', async () => {
        const limitedApp = await createTestApp({
            config: {
                healthzRateLimitMax: 1,
                verifyTokenStoreDir,
            },
        });

        try {
            const firstResponse = await limitedApp.inject({
                method: 'GET',
                url: '/healthz',
            });
            const secondResponse = await limitedApp.inject({
                method: 'GET',
                url: '/healthz',
            });

            expect(firstResponse.statusCode).toBe(200);
            expect(secondResponse.statusCode).toBe(429);
        } finally {
            await limitedApp.close();
        }
    });

    it('renders a centered landing page for the root route', async () => {
        const response = await app.inject({
            method: 'GET',
            url: '/',
            headers: {
                accept: 'text/html',
            },
        });

        expect(response.statusCode).toBe(200);
        expect(response.headers['content-type']).toContain('text/html; charset=utf-8');
        expect(response.headers['cache-control']).toBe('no-store');
        expect(response.headers['content-security-policy']).toContain("style-src 'self' 'nonce-");
        expect(getSetCookieHeaders(response)).toEqual([]);
        expect(response.body).toContain('<title>Magic Link SSO</title>');
        expect(response.body).toContain(
            '<meta name="robots" content="noindex, nofollow, noarchive">',
        );
        expect(response.body).toContain('class="landing-mark"');
        expect(response.body).toContain('🪄');
        expect(response.body).toContain('Magic Link SSO');
    });

    it('returns not found for the root route when the landing page is disabled', async () => {
        const noLandingPageApp = await createTestApp({
            config: {
                serveRootLandingPage: false,
                verifyTokenStoreDir,
            },
        });

        try {
            const response = await noLandingPageApp.inject({
                method: 'GET',
                url: '/',
            });

            expect(response.statusCode).toBe(404);
            expect(getSetCookieHeaders(response)).toEqual([]);
        } finally {
            await noLandingPageApp.close();
        }
    });

    it('serves a robots.txt that disallows crawling', async () => {
        const response = await app.inject({
            method: 'GET',
            url: '/robots.txt',
        });

        expect(response.statusCode).toBe(200);
        expect(response.headers['content-type']).toContain('text/plain; charset=utf-8');
        expect(response.headers['cache-control']).toBe('no-store');
        expect(response.body).toBe('User-agent: *\nDisallow: /\n');
    });

    it('renders the sign-in page with the requested return URL', async () => {
        const response = await app.inject({
            method: 'GET',
            url: '/signin?returnUrl=http://client.example.com/protected',
            headers: {
                accept: 'text/html',
            },
        });

        expect(response.statusCode).toBe(200);
        expect(response.headers['content-type']).toContain('text/html');
        expect(response.headers['cache-control']).toBe('no-store');
        expect(response.headers['content-security-policy']).toContain("form-action 'self'");
        expect(response.headers['content-security-policy']).toContain("script-src 'self' 'nonce-");
        expect(response.headers['permissions-policy']).toBe(
            'camera=(), geolocation=(), microphone=(), payment=(), usb=()',
        );
        expect(response.headers['referrer-policy']).toBe('no-referrer');
        expect(response.headers['x-content-type-options']).toBe('nosniff');
        expect(response.headers['x-frame-options']).toBe('DENY');
        expect(response.body).toContain('http://client.example.com/protected');
        expect(response.body).toContain('Skip to sign-in form');
        expect(response.body).toContain('label class="field-label" for="email">Email</label>');
        expect(response.body).toContain('id="signIn-spinner"');
        expect(response.body).toContain('margin-right 150ms ease');
        expect(response.body).toContain('aria-describedby="signin-help"');
        expect(response.body).toContain('@media (prefers-color-scheme: dark)');
        expect(response.body).toContain('linear-gradient(180deg, #020617 0%, #0f172a 100%)');
        expect(response.body).toMatch(/<style nonce="[^"]+">/);
        expect(response.body).toMatch(/<script nonce="[^"]+">/);
        expect(extractHiddenInputValue(response.body, 'csrfToken')).not.toBe('');
    });

    it('renders a validation error for malformed hosted sign-in page requests', async () => {
        const response = await app.inject({
            method: 'GET',
            url: '/signin?verifyUrl=not-a-url',
            headers: {
                accept: 'text/html',
            },
        });

        expect(response.statusCode).toBe(400);
        expect(response.headers['content-type']).toContain('text/html');
        expect(response.body).toContain('Invalid request');
        expect(response.body).toContain('name="returnUrl" value=""');
        expect(response.body).not.toContain('name="verifyUrl"');
    });

    it('renders an error when the hosted sign-in page request omits both return and verify URLs', async () => {
        const response = await app.inject({
            method: 'GET',
            url: '/signin',
            headers: {
                accept: 'text/html',
            },
        });

        expect(response.statusCode).toBe(400);
        expect(response.headers['content-type']).toContain('text/html');
        expect(response.body).toContain('Invalid request');
        expect(response.body).toContain('name="returnUrl" value=""');
        expect(response.body).toContain('name="scope" value="*"');
        expect(response.body).not.toContain('name="verifyUrl"');
    });

    it('renders the sign-in page for verify-url-only requests', async () => {
        const response = await app.inject({
            method: 'GET',
            url: '/signin?verifyUrl=http://client.example.com/verify-email&scope=album-A',
            headers: {
                accept: 'text/html',
            },
        });

        expect(response.statusCode).toBe(200);
        expect(response.headers['content-type']).toContain('text/html');
        expect(response.body).toContain('name="returnUrl" value=""');
        expect(response.body).toContain(
            'name="verifyUrl" value="http://client.example.com/verify-email"',
        );
        expect(response.body).toContain('name="scope" value="album-A"');
    });

    it('sets HSTS for trusted HTTPS requests', async () => {
        const secureApp = await createTestApp({
            config: {
                trustProxy: true,
                verifyTokenStoreDir,
            },
        });

        try {
            const response = await secureApp.inject({
                method: 'GET',
                url: '/healthz',
                headers: {
                    'x-forwarded-proto': 'https',
                },
            });

            expect(response.statusCode).toBe(200);
            expect(response.headers['strict-transport-security']).toBe(
                'max-age=15552000; includeSubDomains',
            );
        } finally {
            await secureApp.close();
        }
    });

    it('renders localized hosted sign-in text overrides', async () => {
        const localizedCopy = createDefaultHostedAuthPageCopy();
        localizedCopy.lang = 'pl';
        localizedCopy.signin.pageTitle = 'Logowanie';
        localizedCopy.signin.title = 'Zaloguj się';
        localizedCopy.signin.helpText = 'Wyślemy Ci link do logowania.';
        localizedCopy.signin.confirmationPageTitle = 'Sprawdź pocztę';
        localizedCopy.signin.confirmationTitle = 'Sprawdź pocztę';
        localizedCopy.signin.confirmationHelpText =
            'Jeśli ten adres e-mail może się zalogować, wkrótce otrzymasz link.';
        localizedCopy.signin.emailLabel = 'Adres e-mail';
        localizedCopy.signin.emailPlaceholder = 'ty@example.com';
        localizedCopy.signin.submitButton = 'Wyślij link';
        localizedCopy.signin.skipLink = 'Przejdź do formularza logowania';
        localizedCopy.signin.useDifferentEmailButton = 'Użyj innego adresu e-mail';
        localizedCopy.feedback.invalidRequest = 'Nieprawidłowe żądanie';

        const localizedApp = await createTestApp({
            config: {
                hostedAuthPageCopy: localizedCopy,
                verifyTokenStoreDir,
            },
        });

        try {
            const pageResponse = await localizedApp.inject({
                method: 'GET',
                url: '/signin?returnUrl=http://client.example.com/protected',
                headers: {
                    accept: 'text/html',
                },
            });

            expect(pageResponse.body).toContain('<html lang="pl">');
            expect(pageResponse.body).toContain('<title>Logowanie</title>');
            expect(pageResponse.body).toContain('Przejdź do formularza logowania');
            expect(pageResponse.body).toContain('Wyślemy Ci link do logowania.');
            expect(pageResponse.body).toContain('Adres e-mail');
            expect(pageResponse.body).toContain('placeholder="ty@example.com"');
            expect(pageResponse.body).toContain('Wyślij link');
            const cookieHeader = getCookieHeader(pageResponse);
            const csrfToken = extractHiddenInputValue(pageResponse.body, 'csrfToken');

            const successResponse = await localizedApp.inject({
                method: 'POST',
                url: '/signin',
                headers: {
                    'content-type': 'application/x-www-form-urlencoded',
                    accept: 'text/html',
                    cookie: cookieHeader,
                },
                payload: `csrfToken=${encodeURIComponent(csrfToken)}&email=allowed%40example.com&returnUrl=http%3A%2F%2Fclient.example.com%2Fprotected`,
            });

            expect(successResponse.body).toContain('<title>Sprawdź pocztę</title>');
            expect(successResponse.body).toContain(
                'Jeśli ten adres e-mail może się zalogować, wkrótce otrzymasz link.',
            );
            expect(successResponse.body).toContain('Użyj innego adresu e-mail');

            const errorResponse = await localizedApp.inject({
                method: 'POST',
                url: '/signin',
                headers: {
                    'content-type': 'application/x-www-form-urlencoded',
                    accept: 'text/html',
                    cookie: cookieHeader,
                },
                payload: `csrfToken=${encodeURIComponent(csrfToken)}&email=not-an-email`,
            });

            expect(errorResponse.body).toContain('Nieprawidłowe żądanie');
        } finally {
            await localizedApp.close();
        }
    });

    it('renders hosted sign-in branding hooks', async () => {
        const branding = createDefaultHostedAuthBranding();
        branding.title = 'Acme Cloud';
        branding.logoText = 'Acme Identity Platform';
        branding.supportText = 'Need help?';
        branding.supportLinkText = 'Contact support';
        branding.supportLinkUrl = 'mailto:support@example.com';
        branding.signinCssVariables['--color-button-background'] = '#112233';

        const brandedApp = await createTestApp({
            config: {
                hostedAuthBranding: branding,
                verifyTokenStoreDir,
            },
        });

        try {
            const response = await brandedApp.inject({
                method: 'GET',
                url: '/signin?returnUrl=http://client.example.com/protected',
                headers: {
                    accept: 'text/html',
                },
            });

            expect(response.statusCode).toBe(200);
            expect(response.body).toContain('Acme Cloud');
            expect(response.body).toContain('Acme Identity Platform');
            expect(response.body).toContain('brand-mark--text');
            expect(response.body).toContain('background: none;');
            expect(response.body).toContain('text-transform: none;');
            expect(response.body).toContain('Need help?');
            expect(response.body).toContain('Contact support');
            expect(response.body).toContain('mailto:support@example.com');
            expect(response.body).toContain('--color-button-background: #112233;');
        } finally {
            await brandedApp.close();
        }
    });

    it('hides the hosted sign-in eyebrow when logo text matches the brand title', async () => {
        const branding = createDefaultHostedAuthBranding();
        branding.title = 'Acme Cloud';
        branding.logoText = 'Acme Cloud';

        const brandedApp = await createTestApp({
            config: {
                hostedAuthBranding: branding,
                verifyTokenStoreDir,
            },
        });

        try {
            const response = await brandedApp.inject({
                method: 'GET',
                url: '/signin?returnUrl=http://client.example.com/protected',
                headers: {
                    accept: 'text/html',
                },
            });

            expect(response.statusCode).toBe(200);
            expect(response.body).toContain('brand-lockup--standalone');
            expect(response.body).toContain('<span class="brand-mark-text">Acme Cloud</span>');
            expect(response.body).not.toContain('<p class="eyebrow">Acme Cloud</p>');
        } finally {
            await brandedApp.close();
        }
    });

    it('renders site-specific hosted sign-in branding based on the return URL origin', async () => {
        const primarySite = config.sites[0];
        if (typeof primarySite === 'undefined') {
            throw new Error('Expected a default site in test config.');
        }
        const primaryBranding = createDefaultHostedAuthBranding();
        primaryBranding.title = 'Primary Cloud';
        const adminBranding = createDefaultHostedAuthBranding();
        adminBranding.title = 'Admin Cloud';
        adminBranding.logoText = 'AD';

        const multiSiteApp = await createTestApp({
            config: {
                sites: [
                    {
                        ...primarySite,
                        hostedAuthBranding: primaryBranding,
                    },
                    {
                        id: 'admin',
                        origins: new Set(['http://admin.example.com']),
                        allowedRedirectUris: createAllowedRedirectUris([
                            'http://admin.example.com/*',
                        ]),
                        accessRules: createAccessRules({
                            'admin@example.com': [FULL_ACCESS_SCOPE],
                        }),
                        hostedAuthBranding: adminBranding,
                        hostedAuthPageCopy: createDefaultHostedAuthPageCopy(),
                    },
                ],
            },
            sentEmails,
        });

        try {
            const response = await multiSiteApp.inject({
                method: 'GET',
                url: '/signin?returnUrl=http://admin.example.com/dashboard',
                headers: {
                    accept: 'text/html',
                },
            });

            expect(response.statusCode).toBe(200);
            expect(response.body).toContain('Admin Cloud');
            expect(response.body).toContain('AD');
            expect(response.body).not.toContain('Primary Cloud');
        } finally {
            await multiSiteApp.close();
        }
    });

    it('sends a verification email for an allowed JSON sign-in request', async () => {
        const response = await app.inject({
            method: 'POST',
            url: '/signin',
            headers: {
                'content-type': 'application/json',
            },
            payload: {
                email: 'allowed@example.com',
                returnUrl: 'http://client.example.com/protected',
            },
        });

        expect(response.statusCode).toBe(200);
        expect(response.json()).toEqual({ message: 'Verification email sent' });
        expect(sentEmails).toHaveLength(1);
        expect(sentEmails[0]?.email).toBe('allowed@example.com');
        expect(sentEmails[0]?.siteTitle).toBe(config.sites[0]?.hostedAuthBranding.title);
        expect(sentEmails[0]?.verifyUrl).toBe('http://sso.example.com/verify-email');

        const payload = await verifyEmailToken(sentEmails[0]?.token ?? '', config.emailSecret);
        expect(payload?.email).toBe('allowed@example.com');
        expect(payload?.returnUrl).toBe('http://client.example.com/protected');
        expect(payload?.scope).toBe(FULL_ACCESS_SCOPE);
        expect(payload?.siteId).toBe('client');
    });

    it('rejects JSON-like sign-in requests without an application/json content type', async () => {
        const response = await app.inject({
            method: 'POST',
            url: '/signin',
            headers: {
                accept: 'application/json',
                'content-type': 'text/plain;charset=UTF-8',
            },
            payload: JSON.stringify({
                email: 'allowed@example.com',
                returnUrl: 'http://client.example.com/protected',
            }),
        });

        expect(response.statusCode).toBe(403);
        expect(response.json()).toEqual({ message: 'Invalid or missing CSRF token' });
        expect(sentEmails).toHaveLength(0);
    });

    it('rejects cross-origin JSON sign-in mutations', async () => {
        const response = await app.inject({
            method: 'POST',
            url: '/signin',
            headers: {
                accept: 'application/json',
                'content-type': 'application/json',
                origin: 'https://attacker.example.com',
            },
            payload: {
                email: 'allowed@example.com',
                returnUrl: 'http://client.example.com/protected',
            },
        });

        expect(response.statusCode).toBe(403);
        expect(response.json()).toEqual({ message: 'Invalid or missing CSRF token' });
        expect(sentEmails).toHaveLength(0);
    });

    it('allows explicit scopes for users with wildcard access', async () => {
        const response = await app.inject({
            method: 'POST',
            url: '/signin',
            headers: {
                'content-type': 'application/json',
            },
            payload: {
                email: 'allowed@example.com',
                returnUrl: 'http://client.example.com/protected',
                scope: 'album-A',
            },
        });

        expect(response.statusCode).toBe(200);
        const payload = await verifyEmailToken(sentEmails[0]?.token ?? '', config.emailSecret);
        expect(payload?.scope).toBe('album-A');
    });

    it('allows only explicitly granted scopes for scoped users', async () => {
        const primarySite = config.sites[0];
        if (typeof primarySite === 'undefined') {
            throw new Error('Expected a default site in test config.');
        }
        const scopedApp = await createTestApp({
            config: {
                sites: [
                    {
                        ...primarySite,
                        accessRules: createAccessRules({
                            'member@example.com': ['album-A'],
                        }),
                    },
                ],
            },
            sentEmails,
        });

        try {
            const response = await scopedApp.inject({
                method: 'POST',
                url: '/signin',
                headers: {
                    'content-type': 'application/json',
                },
                payload: {
                    email: 'member@example.com',
                    returnUrl: 'http://client.example.com/protected',
                    scope: 'album-A',
                },
            });

            expect(response.statusCode).toBe(200);
            const payload = await verifyEmailToken(sentEmails[0]?.token ?? '', config.emailSecret);
            expect(payload?.scope).toBe('album-A');
        } finally {
            await scopedApp.close();
        }
    });

    it('rejects users requesting a scope they do not have', async () => {
        const primarySite = config.sites[0];
        if (typeof primarySite === 'undefined') {
            throw new Error('Expected a default site in test config.');
        }
        const scopedApp = await createTestApp({
            config: {
                sites: [
                    {
                        ...primarySite,
                        accessRules: createAccessRules({
                            'member@example.com': ['album-A'],
                        }),
                    },
                ],
            },
            sentEmails,
        });

        try {
            const response = await scopedApp.inject({
                method: 'POST',
                url: '/signin',
                headers: {
                    'content-type': 'application/json',
                },
                payload: {
                    email: 'member@example.com',
                    returnUrl: 'http://client.example.com/protected',
                    scope: 'album-B',
                },
            });

            expect(response.statusCode).toBe(200);
            expect(response.json()).toEqual({ message: 'Verification email sent' });
            expect(sentEmails).toHaveLength(0);
        } finally {
            await scopedApp.close();
        }
    });

    it('defaults omitted scopes to wildcard access', async () => {
        const primarySite = config.sites[0];
        if (typeof primarySite === 'undefined') {
            throw new Error('Expected a default site in test config.');
        }
        const scopedApp = await createTestApp({
            config: {
                sites: [
                    {
                        ...primarySite,
                        accessRules: createAccessRules({
                            'member@example.com': ['album-A'],
                        }),
                    },
                ],
            },
            sentEmails,
        });

        try {
            const response = await scopedApp.inject({
                method: 'POST',
                url: '/signin',
                headers: {
                    'content-type': 'application/json',
                },
                payload: {
                    email: 'member@example.com',
                    returnUrl: 'http://client.example.com/protected',
                },
            });

            expect(response.statusCode).toBe(200);
            expect(response.json()).toEqual({ message: 'Verification email sent' });
            expect(sentEmails).toHaveLength(0);
        } finally {
            await scopedApp.close();
        }
    });

    it('renders a confirmation state for a browser sign-in request', async () => {
        const { cookieHeader, csrfToken } = await getSigninFormSecurityContext(app);
        const response = await app.inject({
            method: 'POST',
            url: '/signin',
            headers: {
                'content-type': 'application/x-www-form-urlencoded',
                accept: 'text/html',
                cookie: cookieHeader,
            },
            payload: `csrfToken=${encodeURIComponent(csrfToken)}&email=allowed%40example.com&returnUrl=http%3A%2F%2Fclient.example.com%2Fprotected`,
        });

        expect(response.statusCode).toBe(200);
        expect(response.headers['content-type']).toContain('text/html');
        expect(response.body).toContain('<title>Check Your Email</title>');
        expect(response.body).toContain('Check your email');
        expect(response.body).toContain(
            'If your email can sign in, you will receive a link shortly. Open the email and click the link to continue.',
        );
        expect(response.body).toContain('Use a different email');
        expect(response.body).toContain('role="status"');
        expect(response.body).not.toContain('id="email"');
        expect(response.body).not.toContain('id="signIn"');
        expect(response.body).not.toContain('allowed@example.com');
        expect(response.body).not.toContain('Verification email sent');
        expect(sentEmails).toHaveLength(1);
    });

    it('passes the resolved site title to verification emails in multisite mode', async () => {
        const primarySite = config.sites[0];
        if (typeof primarySite === 'undefined') {
            throw new Error('Expected a default site in test config.');
        }
        const primaryBranding = createDefaultHostedAuthBranding();
        primaryBranding.title = 'Primary Cloud';
        const adminBranding = createDefaultHostedAuthBranding();
        adminBranding.title = 'Admin Cloud';

        const multiSiteApp = await createTestApp({
            config: {
                sites: [
                    {
                        ...primarySite,
                        hostedAuthBranding: primaryBranding,
                    },
                    {
                        id: 'admin',
                        origins: new Set(['http://admin.example.com']),
                        allowedRedirectUris: createAllowedRedirectUris([
                            'http://admin.example.com/*',
                        ]),
                        accessRules: createAccessRules({
                            'admin@example.com': [FULL_ACCESS_SCOPE],
                        }),
                        hostedAuthBranding: adminBranding,
                        hostedAuthPageCopy: createDefaultHostedAuthPageCopy(),
                    },
                ],
            },
            sentEmails,
        });

        try {
            const response = await multiSiteApp.inject({
                method: 'POST',
                url: '/signin',
                headers: {
                    'content-type': 'application/json',
                },
                payload: {
                    email: 'admin@example.com',
                    returnUrl: 'http://admin.example.com/dashboard',
                },
            });

            expect(response.statusCode).toBe(200);
            expect(sentEmails).toHaveLength(1);
            expect(sentEmails[0]?.siteTitle).toBe('Admin Cloud');
        } finally {
            await multiSiteApp.close();
        }
    });

    it('validates browser csrf tokens independently from the JWT signing secret', async () => {
        const sharedCsrfSecret = 'shared-csrf-secret';
        const firstApp = await createTestApp({
            config: {
                csrfSecret: sharedCsrfSecret,
                jwtSecret: 'first-jwt-secret',
            },
        });
        const secondSentEmails: VerificationEmailInput[] = [];
        const secondApp = await createTestApp({
            config: {
                csrfSecret: sharedCsrfSecret,
                jwtSecret: 'second-jwt-secret',
            },
            sentEmails: secondSentEmails,
        });

        try {
            const { cookieHeader, csrfToken } = await getSigninFormSecurityContext(firstApp);
            const response = await secondApp.inject({
                method: 'POST',
                url: '/signin',
                headers: {
                    'content-type': 'application/x-www-form-urlencoded',
                    accept: 'text/html',
                    cookie: cookieHeader,
                },
                payload: `csrfToken=${encodeURIComponent(csrfToken)}&email=allowed%40example.com&returnUrl=http%3A%2F%2Fclient.example.com%2Fprotected`,
            });

            expect(response.statusCode).toBe(200);
            expect(response.body).toContain('Check your email');
            expect(secondSentEmails).toHaveLength(1);
        } finally {
            await firstApp.close();
            await secondApp.close();
        }
    });

    it('rejects browser sign-in requests with an invalid csrf token', async () => {
        const { cookieHeader } = await getSigninFormSecurityContext(app);
        const response = await app.inject({
            method: 'POST',
            url: '/signin',
            headers: {
                'content-type': 'application/x-www-form-urlencoded',
                accept: 'text/html',
                cookie: cookieHeader,
            },
            payload:
                'csrfToken=invalid&email=allowed%40example.com&returnUrl=http%3A%2F%2Fclient.example.com%2Fprotected',
        });

        expect(response.statusCode).toBe(403);
        expect(response.body).toContain('Invalid request');
        expect(response.body).not.toContain('allowed@example.com');
        expect(response.body).not.toContain('value="allowed@example.com"');
        expect(sentEmails).toHaveLength(0);
    });

    it('preserves hosted sign-in scope across browser rerenders', async () => {
        const response = await app.inject({
            method: 'GET',
            url: `/signin?returnUrl=${encodeURIComponent('http://client.example.com/protected')}&scope=${encodeURIComponent('album-A')}`,
            headers: {
                accept: 'text/html',
            },
        });

        expect(response.statusCode).toBe(200);
        const cookieHeader = getCookieHeader(response);
        const csrfToken = extractHiddenInputValue(response.body, 'csrfToken');
        expect(extractHiddenInputValue(response.body, 'scope')).toBe('album-A');

        const postResponse = await app.inject({
            method: 'POST',
            url: '/signin',
            headers: {
                'content-type': 'application/x-www-form-urlencoded',
                accept: 'text/html',
                cookie: cookieHeader,
            },
            payload: `csrfToken=${encodeURIComponent(csrfToken)}&email=blocked%40example.com&returnUrl=${encodeURIComponent('http://client.example.com/protected')}&scope=${encodeURIComponent('album-A')}`,
        });

        expect(postResponse.statusCode).toBe(200);
        expect(postResponse.body).toContain('Use a different email');
        expect(extractLinkHref(postResponse.body, 'secondary-link')).toBe(
            '/signin?returnUrl=http%3A%2F%2Fclient.example.com%2Fprotected&scope=album-A',
        );
        expect(sentEmails).toHaveLength(0);
    });

    it('renders the same confirmation state for a disallowed browser sign-in request', async () => {
        const { cookieHeader, csrfToken } = await getSigninFormSecurityContext(app);
        const response = await app.inject({
            method: 'POST',
            url: '/signin',
            headers: {
                'content-type': 'application/x-www-form-urlencoded',
                accept: 'text/html',
                cookie: cookieHeader,
            },
            payload: `csrfToken=${encodeURIComponent(csrfToken)}&email=blocked%40example.com&returnUrl=http%3A%2F%2Fclient.example.com%2Fprotected&scope=${encodeURIComponent('album-A')}&verifyUrl=${encodeURIComponent('http://client.example.com/verify-email')}`,
        });

        expect(response.statusCode).toBe(200);
        expect(response.body).toContain('<title>Check Your Email</title>');
        expect(response.body).toContain('Check your email');
        expect(response.body).toContain('Use a different email');
        expect(response.body).not.toContain('id="email"');
        expect(response.body).not.toContain('blocked@example.com');
        expect(extractLinkHref(response.body, 'secondary-link')).toBe(
            '/signin?returnUrl=http%3A%2F%2Fclient.example.com%2Fprotected&scope=album-A&verifyUrl=http%3A%2F%2Fclient.example.com%2Fverify-email',
        );
        expect(sentEmails).toHaveLength(0);
    });

    it('allows exact verify callbacks and strict return-url subpaths', async () => {
        const primarySite = config.sites[0];
        if (typeof primarySite === 'undefined') {
            throw new Error('Expected a default site in test config.');
        }

        const scopedEmails: VerificationEmailInput[] = [];
        const scopedApp = await createTestApp({
            config: {
                sites: [
                    {
                        ...primarySite,
                        allowedRedirectUris: createAllowedRedirectUris([
                            'http://client.example.com/verify-email',
                            'http://client.example.com/app/*',
                        ]),
                    },
                ],
            },
            sentEmails: scopedEmails,
        });

        try {
            const response = await scopedApp.inject({
                method: 'POST',
                url: '/signin',
                headers: {
                    'content-type': 'application/json',
                },
                payload: {
                    email: 'allowed@example.com',
                    returnUrl: 'http://client.example.com/app/protected?tab=recent',
                    verifyUrl:
                        'http://client.example.com/verify-email?returnUrl=http%3A%2F%2Fclient.example.com%2Fapp%2Fprotected',
                },
            });

            expect(response.statusCode).toBe(200);
            expect(response.json()).toEqual({ message: 'Verification email sent' });
            expect(scopedEmails).toHaveLength(1);
            expect(scopedEmails[0]?.verifyUrl).toBe(
                'http://client.example.com/verify-email?returnUrl=http%3A%2F%2Fclient.example.com%2Fapp%2Fprotected',
            );
        } finally {
            await scopedApp.close();
        }
    });

    it('rejects sibling paths that only share a subpath prefix', async () => {
        const primarySite = config.sites[0];
        if (typeof primarySite === 'undefined') {
            throw new Error('Expected a default site in test config.');
        }

        const scopedApp = await createTestApp({
            config: {
                sites: [
                    {
                        ...primarySite,
                        allowedRedirectUris: createAllowedRedirectUris([
                            'http://client.example.com/verify-email',
                            'http://client.example.com/app/*',
                        ]),
                    },
                ],
            },
        });

        try {
            const response = await scopedApp.inject({
                method: 'POST',
                url: '/signin',
                headers: {
                    'content-type': 'application/json',
                },
                payload: {
                    email: 'allowed@example.com',
                    returnUrl: 'http://client.example.com/app-malicious',
                    verifyUrl: 'http://client.example.com/verify-email',
                },
            });

            expect(response.statusCode).toBe(400);
            expect(response.json()).toEqual({ message: 'Invalid or untrusted return URL' });
            expect(sentEmails).toHaveLength(0);
        } finally {
            await scopedApp.close();
        }
    });

    it('rejects traversal-like return URLs even when they normalize to an allowed path', async () => {
        const primarySite = config.sites[0];
        if (typeof primarySite === 'undefined') {
            throw new Error('Expected a default site in test config.');
        }

        const scopedApp = await createTestApp({
            config: {
                sites: [
                    {
                        ...primarySite,
                        allowedRedirectUris: createAllowedRedirectUris([
                            'http://client.example.com/admin',
                            'http://client.example.com/verify-email',
                            'http://client.example.com/app/*',
                        ]),
                    },
                ],
            },
        });

        try {
            const response = await scopedApp.inject({
                method: 'POST',
                url: '/signin',
                headers: {
                    'content-type': 'application/json',
                },
                payload: {
                    email: 'allowed@example.com',
                    returnUrl: 'http://client.example.com/app/%2e%2e/admin',
                    verifyUrl: 'http://client.example.com/verify-email',
                },
            });

            expect(response.statusCode).toBe(400);
            expect(response.json()).toEqual({ message: 'Invalid or untrusted return URL' });
        } finally {
            await scopedApp.close();
        }
    });

    it('rejects verify URLs that use userinfo in the authority component', async () => {
        const primarySite = config.sites[0];
        if (typeof primarySite === 'undefined') {
            throw new Error('Expected a default site in test config.');
        }

        const scopedApp = await createTestApp({
            config: {
                sites: [
                    {
                        ...primarySite,
                        allowedRedirectUris: createAllowedRedirectUris([
                            'http://client.example.com/verify-email',
                            'http://client.example.com/app/*',
                        ]),
                    },
                ],
            },
        });

        try {
            const response = await scopedApp.inject({
                method: 'POST',
                url: '/signin',
                headers: {
                    'content-type': 'application/json',
                },
                payload: {
                    email: 'allowed@example.com',
                    returnUrl: 'http://client.example.com/app/protected',
                    verifyUrl: 'http://client.example.com@evil.example.com/verify-email',
                },
            });

            expect(response.statusCode).toBe(400);
            expect(response.json()).toEqual({ message: 'Invalid or untrusted verify URL' });
        } finally {
            await scopedApp.close();
        }
    });

    it('rejects verify URLs outside the configured redirect allowlist', async () => {
        const primarySite = config.sites[0];
        if (typeof primarySite === 'undefined') {
            throw new Error('Expected a default site in test config.');
        }

        const scopedApp = await createTestApp({
            config: {
                sites: [
                    {
                        ...primarySite,
                        allowedRedirectUris: createAllowedRedirectUris([
                            'http://client.example.com/verify-email',
                            'http://client.example.com/app/*',
                        ]),
                    },
                ],
            },
        });

        try {
            const response = await scopedApp.inject({
                method: 'POST',
                url: '/signin',
                headers: {
                    'content-type': 'application/json',
                },
                payload: {
                    email: 'allowed@example.com',
                    returnUrl: 'http://client.example.com/app/protected',
                    verifyUrl: 'http://client.example.com/open-redirect',
                },
            });

            expect(response.statusCode).toBe(400);
            expect(response.json()).toEqual({ message: 'Invalid or untrusted verify URL' });
        } finally {
            await scopedApp.close();
        }
    });

    it('rejects return URLs outside the configured redirect allowlist', async () => {
        const primarySite = config.sites[0];
        if (typeof primarySite === 'undefined') {
            throw new Error('Expected a default site in test config.');
        }

        const scopedApp = await createTestApp({
            config: {
                sites: [
                    {
                        ...primarySite,
                        allowedRedirectUris: createAllowedRedirectUris([
                            'http://client.example.com/verify-email',
                            'http://client.example.com/app/*',
                        ]),
                    },
                ],
            },
        });

        try {
            const response = await scopedApp.inject({
                method: 'POST',
                url: '/signin',
                headers: {
                    'content-type': 'application/json',
                },
                payload: {
                    email: 'allowed@example.com',
                    returnUrl: 'http://client.example.com/admin',
                    verifyUrl: 'http://client.example.com/verify-email',
                },
            });

            expect(response.statusCode).toBe(400);
            expect(response.json()).toEqual({ message: 'Invalid or untrusted return URL' });
        } finally {
            await scopedApp.close();
        }
    });

    it('rejects untrusted verify URLs', async () => {
        const response = await app.inject({
            method: 'POST',
            url: '/signin',
            headers: {
                'content-type': 'application/json',
            },
            payload: {
                email: 'allowed@example.com',
                verifyUrl: 'https://attacker.example.com/verify-email',
            },
        });

        expect(response.statusCode).toBe(400);
        expect(response.json()).toEqual({ message: 'Invalid or untrusted verify URL' });
        expect(sentEmails).toHaveLength(0);
    });

    it('renders an HTML error for untrusted browser verify URLs', async () => {
        const { cookieHeader, csrfToken } = await getSigninFormSecurityContext(app);
        const response = await app.inject({
            method: 'POST',
            url: '/signin',
            headers: {
                'content-type': 'application/x-www-form-urlencoded',
                accept: 'text/html',
                cookie: cookieHeader,
            },
            payload: `csrfToken=${encodeURIComponent(csrfToken)}&email=allowed%40example.com&verifyUrl=${encodeURIComponent('https://attacker.example.com/verify-email')}`,
        });

        expect(response.statusCode).toBe(400);
        expect(response.headers['content-type']).toContain('text/html');
        expect(response.body).toContain('Invalid or untrusted verify URL');
        expect(response.body).not.toContain('allowed@example.com');
        expect(response.body).not.toContain('value="allowed@example.com"');
        expect(sentEmails).toHaveLength(0);
    });

    it('returns a uniform success response for a disallowed email without sending mail', async () => {
        const response = await app.inject({
            method: 'POST',
            url: '/signin',
            headers: {
                'content-type': 'application/json',
            },
            payload: {
                email: 'blocked@example.com',
                returnUrl: 'http://client.example.com/protected',
            },
        });

        expect(response.statusCode).toBe(200);
        expect(response.json()).toEqual({ message: 'Verification email sent' });
        expect(sentEmails).toHaveLength(0);
    });

    it('uses site-scoped access rules during sign-in', async () => {
        const primarySite = config.sites[0];
        if (typeof primarySite === 'undefined') {
            throw new Error('Expected a default site in test config.');
        }
        const multiSiteApp = await createTestApp({
            config: {
                sites: [
                    {
                        ...primarySite,
                        accessRules: createAccessRules({
                            'allowed@example.com': [FULL_ACCESS_SCOPE],
                        }),
                    },
                    {
                        id: 'admin',
                        origins: new Set(['http://admin.example.com']),
                        allowedRedirectUris: createAllowedRedirectUris([
                            'http://admin.example.com/*',
                        ]),
                        accessRules: createAccessRules({
                            'admin@example.com': [FULL_ACCESS_SCOPE],
                        }),
                        hostedAuthBranding: createDefaultHostedAuthBranding(),
                        hostedAuthPageCopy: createDefaultHostedAuthPageCopy(),
                    },
                ],
            },
            sentEmails,
        });

        try {
            const blockedResponse = await multiSiteApp.inject({
                method: 'POST',
                url: '/signin',
                headers: {
                    'content-type': 'application/json',
                },
                payload: {
                    email: 'admin@example.com',
                    returnUrl: 'http://client.example.com/protected',
                },
            });

            expect(blockedResponse.statusCode).toBe(200);
            expect(blockedResponse.json()).toEqual({ message: 'Verification email sent' });
            expect(sentEmails).toHaveLength(0);

            const allowedResponse = await multiSiteApp.inject({
                method: 'POST',
                url: '/signin',
                headers: {
                    'content-type': 'application/json',
                },
                payload: {
                    email: 'admin@example.com',
                    returnUrl: 'http://admin.example.com/dashboard',
                },
            });

            expect(allowedResponse.statusCode).toBe(200);
            expect(sentEmails).toHaveLength(1);
        } finally {
            await multiSiteApp.close();
        }
    });

    it('returns a validation error for malformed JSON sign-in requests', async () => {
        const response = await app.inject({
            method: 'POST',
            url: '/signin',
            headers: {
                'content-type': 'application/json',
            },
            payload: {
                email: 'not-an-email',
            },
        });

        expect(response.statusCode).toBe(400);
        expect(response.json()).toEqual({ message: 'Invalid request' });
        expect(sentEmails).toHaveLength(0);
    });

    it('rejects email addresses longer than 254 characters', async () => {
        const response = await app.inject({
            method: 'POST',
            url: '/signin',
            headers: {
                'content-type': 'application/json',
            },
            payload: {
                email: `${'a'.repeat(243)}@example.com`,
                returnUrl: 'http://client.example.com/protected',
            },
        });

        expect(response.statusCode).toBe(400);
        expect(response.json()).toEqual({ message: 'Invalid request' });
        expect(sentEmails).toHaveLength(0);
    });

    it('rate limits repeated sign-in attempts for the same email and client IP', async () => {
        const limitedApp = await createTestApp({
            config: {
                signInEmailRateLimitMax: 1,
                signInEmailRateLimitStoreDir,
                verifyTokenStoreDir,
            },
            sentEmails,
        });

        try {
            const firstResponse = await limitedApp.inject({
                method: 'POST',
                url: '/signin',
                headers: {
                    'content-type': 'application/json',
                },
                payload: {
                    email: 'allowed@example.com',
                    returnUrl: 'http://client.example.com/protected',
                },
            });
            const secondResponse = await limitedApp.inject({
                method: 'POST',
                url: '/signin',
                headers: {
                    'content-type': 'application/json',
                },
                payload: {
                    email: 'allowed@example.com',
                    returnUrl: 'http://client.example.com/protected',
                },
            });

            expect(firstResponse.statusCode).toBe(200);
            expect(secondResponse.statusCode).toBe(429);
            expect(secondResponse.json()).toEqual({ message: 'Too many requests' });
            expect(secondResponse.headers['retry-after']).toBe('60');
            expect(sentEmails).toHaveLength(1);
        } finally {
            await limitedApp.close();
        }
    });

    it('renders an HTML rate-limit error without echoing the submitted email', async () => {
        const limitedApp = await createTestApp({
            config: {
                signInEmailRateLimitMax: 1,
                signInEmailRateLimitStoreDir,
                verifyTokenStoreDir,
            },
            sentEmails,
        });

        try {
            const { cookieHeader, csrfToken } = await getSigninFormSecurityContext(limitedApp);
            const firstResponse = await limitedApp.inject({
                method: 'POST',
                url: '/signin',
                headers: {
                    'content-type': 'application/x-www-form-urlencoded',
                    accept: 'text/html',
                    cookie: cookieHeader,
                },
                payload: `csrfToken=${encodeURIComponent(csrfToken)}&email=allowed%40example.com&returnUrl=${encodeURIComponent('http://client.example.com/protected')}&scope=${encodeURIComponent('album-A')}`,
            });
            const secondResponse = await limitedApp.inject({
                method: 'POST',
                url: '/signin',
                headers: {
                    'content-type': 'application/x-www-form-urlencoded',
                    accept: 'text/html',
                    cookie: cookieHeader,
                },
                payload: `csrfToken=${encodeURIComponent(csrfToken)}&email=allowed%40example.com&returnUrl=${encodeURIComponent('http://client.example.com/protected')}&scope=${encodeURIComponent('album-A')}`,
            });

            expect(firstResponse.statusCode).toBe(200);
            expect(secondResponse.statusCode).toBe(429);
            expect(secondResponse.headers['content-type']).toContain('text/html');
            expect(secondResponse.headers['retry-after']).toBe('60');
            expect(secondResponse.body).toContain('Too many requests');
            expect(secondResponse.body).toContain('role="alert"');
            expect(secondResponse.body).not.toContain('allowed@example.com');
            expect(secondResponse.body).not.toContain('value="allowed@example.com"');
            expect(extractHiddenInputValue(secondResponse.body, 'returnUrl')).toBe(
                'http://client.example.com/protected',
            );
            expect(extractHiddenInputValue(secondResponse.body, 'scope')).toBe('album-A');
            expect(sentEmails).toHaveLength(1);
        } finally {
            await limitedApp.close();
        }
    });

    it('rate limits repeated sign-in attempts for the same email across client IP changes', async () => {
        const limitedApp = await createTestApp({
            config: {
                signInEmailRateLimitMax: 1,
                signInEmailRateLimitStoreDir,
                verifyTokenStoreDir,
            },
            sentEmails,
        });

        try {
            const firstResponse = await limitedApp.inject({
                method: 'POST',
                remoteAddress: '127.0.0.1',
                url: '/signin',
                headers: {
                    'content-type': 'application/json',
                },
                payload: {
                    email: 'allowed@example.com',
                    returnUrl: 'http://client.example.com/protected',
                },
            });
            const secondResponse = await limitedApp.inject({
                method: 'POST',
                remoteAddress: '127.0.0.2',
                url: '/signin',
                headers: {
                    'content-type': 'application/json',
                },
                payload: {
                    email: 'allowed@example.com',
                    returnUrl: 'http://client.example.com/protected',
                },
            });

            expect(firstResponse.statusCode).toBe(200);
            expect(secondResponse.statusCode).toBe(429);
            expect(secondResponse.json()).toEqual({ message: 'Too many requests' });
            expect(secondResponse.headers['retry-after']).toBe('60');
            expect(sentEmails).toHaveLength(1);
        } finally {
            await limitedApp.close();
        }
    });

    it('keeps per-email rate limits across app restarts with the file-backed store', async () => {
        const persistentStoreDir = mkdtempSync(join(tmpdir(), 'magic-sso-email-limit-restart-'));
        const restartConfig = {
            signInEmailRateLimitMax: 1,
            signInEmailRateLimitStoreDir: persistentStoreDir,
            verifyTokenStoreDir,
        };
        const firstApp = await createTestApp({
            config: restartConfig,
            sentEmails,
        });

        try {
            const firstResponse = await firstApp.inject({
                method: 'POST',
                url: '/signin',
                headers: {
                    'content-type': 'application/json',
                },
                payload: {
                    email: 'allowed@example.com',
                    returnUrl: 'http://client.example.com/protected',
                },
            });

            expect(firstResponse.statusCode).toBe(200);
        } finally {
            await firstApp.close();
        }

        const secondApp = await createTestApp({
            config: restartConfig,
            sentEmails,
        });

        try {
            const secondResponse = await secondApp.inject({
                method: 'POST',
                url: '/signin',
                headers: {
                    'content-type': 'application/json',
                },
                payload: {
                    email: 'allowed@example.com',
                    returnUrl: 'http://client.example.com/protected',
                },
            });

            expect(secondResponse.statusCode).toBe(429);
            expect(secondResponse.json()).toEqual({ message: 'Too many requests' });
            expect(secondResponse.headers['retry-after']).toBe('60');
            expect(sentEmails).toHaveLength(1);
        } finally {
            await secondApp.close();
            rmSync(persistentStoreDir, { recursive: true, force: true });
        }
    });

    it('logs rejected sign-in attempts without including raw email addresses', async () => {
        let logs = '';
        const logStream = new PassThrough();
        logStream.setEncoding('utf8');
        logStream.on('data', (chunk: string) => {
            logs += chunk;
        });
        const loggedApp = await createTestApp({
            config: {
                verifyTokenStoreDir,
            },
            logger: {
                level: 'info',
                stream: logStream,
            },
        });

        try {
            const response = await loggedApp.inject({
                method: 'POST',
                url: '/signin',
                headers: {
                    'content-type': 'application/json',
                },
                payload: {
                    email: 'blocked@example.com',
                    returnUrl: 'http://client.example.com/protected',
                },
            });

            expect(response.statusCode).toBe(200);
            await waitForLogFlush();
            expect(logs).toContain('"emailDomain":"example.com"');
            expect(logs).toContain('"emailHash":"');
            expect(logs).not.toContain('blocked@example.com');
        } finally {
            await loggedApp.close();
        }
    });

    it('rejects untrusted return URLs during sign-in', async () => {
        const response = await app.inject({
            method: 'POST',
            url: '/signin',
            headers: {
                'content-type': 'application/json',
            },
            payload: {
                email: 'allowed@example.com',
                returnUrl: 'https://attacker.example.com/steal-session',
            },
        });

        expect(response.statusCode).toBe(400);
        expect(response.json()).toEqual({ message: 'Invalid or untrusted return URL' });
        expect(sentEmails).toHaveLength(0);
    });

    it('renders an HTML error for untrusted browser return URLs', async () => {
        const { cookieHeader, csrfToken } = await getSigninFormSecurityContext(app);
        const response = await app.inject({
            method: 'POST',
            url: '/signin',
            headers: {
                'content-type': 'application/x-www-form-urlencoded',
                accept: 'text/html',
                cookie: cookieHeader,
            },
            payload: `csrfToken=${encodeURIComponent(csrfToken)}&email=allowed%40example.com&returnUrl=${encodeURIComponent('https://attacker.example.com/steal-session')}&scope=${encodeURIComponent('album-A')}`,
        });

        expect(response.statusCode).toBe(400);
        expect(response.headers['content-type']).toContain('text/html');
        expect(response.body).toContain('Invalid or untrusted return URL');
        expect(response.body).toContain('role="alert"');
        expect(response.body).not.toContain('allowed@example.com');
        expect(response.body).not.toContain('value="allowed@example.com"');
        expect(extractHiddenInputValue(response.body, 'csrfToken')).not.toBe('');
        expect(extractHiddenInputValue(response.body, 'scope')).toBe('album-A');
        expect(sentEmails).toHaveLength(0);
    });

    it('renders a validation error for malformed browser sign-in requests', async () => {
        const { cookieHeader, csrfToken } = await getSigninFormSecurityContext(app);
        const response = await app.inject({
            method: 'POST',
            url: '/signin',
            headers: {
                'content-type': 'application/x-www-form-urlencoded',
                accept: 'text/html',
                cookie: cookieHeader,
            },
            payload: `csrfToken=${encodeURIComponent(csrfToken)}&email=not-an-email`,
        });

        expect(response.statusCode).toBe(400);
        expect(response.headers['content-type']).toContain('text/html');
        expect(response.body).toContain('Invalid request');
        expect(response.body).toContain('role="alert"');
        expect(response.body).not.toContain('not-an-email');
        expect(response.body).not.toContain('value="not-an-email"');
        expect(sentEmails).toHaveLength(0);
    });

    it('returns an error when email delivery fails for JSON requests', async () => {
        const failingApp = await createTestApp({
            mailer: {
                async sendVerificationEmail(): Promise<void> {
                    throw new Error('smtp unavailable');
                },
            },
        });

        try {
            const response = await failingApp.inject({
                method: 'POST',
                url: '/signin',
                headers: {
                    'content-type': 'application/json',
                },
                payload: {
                    email: 'allowed@example.com',
                    returnUrl: 'http://client.example.com/protected',
                },
            });

            expect(response.statusCode).toBe(500);
            expect(response.json()).toEqual({ message: 'Failed to send email' });
        } finally {
            await failingApp.close();
        }
    });

    it('renders an error when email delivery fails for browser requests', async () => {
        const failingApp = await createTestApp({
            mailer: {
                async sendVerificationEmail(): Promise<void> {
                    throw new Error('smtp unavailable');
                },
            },
        });

        try {
            const { cookieHeader, csrfToken } = await getSigninFormSecurityContext(failingApp);
            const response = await failingApp.inject({
                method: 'POST',
                url: '/signin',
                headers: {
                    'content-type': 'application/x-www-form-urlencoded',
                    accept: 'text/html',
                    cookie: cookieHeader,
                },
                payload: `csrfToken=${encodeURIComponent(csrfToken)}&email=allowed%40example.com&returnUrl=http%3A%2F%2Fclient.example.com%2Fprotected`,
            });

            expect(response.statusCode).toBe(500);
            expect(response.headers['content-type']).toContain('text/html');
            expect(response.body).toContain('Failed to send email');
            expect(response.body).toContain('role="alert"');
            expect(response.body).not.toContain('allowed@example.com');
            expect(response.body).not.toContain('value="allowed@example.com"');
        } finally {
            await failingApp.close();
        }
    });

    it('returns a JSON access token for programmatic verification POST requests', async () => {
        const token = await generateEmailToken(
            'allowed@example.com',
            'http://client.example.com/protected',
            'client',
            FULL_ACCESS_SCOPE,
            config.emailSecret,
            config.emailExpirationSeconds,
        );

        const response = await app.inject({
            method: 'POST',
            url: '/verify-email',
            headers: {
                'content-type': 'application/json',
            },
            payload: JSON.stringify({ token }),
        });

        expect(response.statusCode).toBe(200);
        const body = z
            .object({
                accessToken: z.string(),
            })
            .parse(response.json());
        const payload = await verifyAccessToken(body.accessToken, config.jwtSecret, {
            expectedAudience: 'http://client.example.com',
            expectedIssuer: new URL(config.appUrl).origin,
        });
        expect(payload?.email).toBe('allowed@example.com');
        expect(payload?.scope).toBe(FULL_ACCESS_SCOPE);
        expect(payload?.siteId).toBe('client');
        expect(payload?.iss).toBe('http://sso.example.com');
    });

    it('accepts verification tokens with an audience array containing the site id', async () => {
        const token = await generateEmailTokenWithAudience(
            'allowed@example.com',
            'http://client.example.com/protected',
            'client',
            FULL_ACCESS_SCOPE,
            ['legacy-client', 'client'],
            config.emailSecret,
            config.emailExpirationSeconds,
        );

        const response = await app.inject({
            method: 'POST',
            url: '/verify-email',
            headers: {
                'content-type': 'application/json',
            },
            payload: JSON.stringify({ token }),
        });

        expect(response.statusCode).toBe(200);
        const body = z
            .object({
                accessToken: z.string(),
            })
            .parse(response.json());
        expect(body.accessToken).not.toBe('');
    });

    it('rejects JSON-like verify-email requests without an application/json content type', async () => {
        const token = await generateEmailToken(
            'allowed@example.com',
            'http://client.example.com/protected',
            'client',
            FULL_ACCESS_SCOPE,
            config.emailSecret,
            config.emailExpirationSeconds,
        );

        const response = await app.inject({
            method: 'POST',
            url: '/verify-email',
            headers: {
                accept: 'application/json',
                'content-type': 'text/plain;charset=UTF-8',
            },
            payload: JSON.stringify({ token }),
        });

        expect(response.statusCode).toBe(403);
        expect(response.json()).toEqual({ message: 'Invalid or missing CSRF token' });
    });

    it('rejects cross-origin JSON verify-email mutations', async () => {
        const token = await generateEmailToken(
            'allowed@example.com',
            'http://client.example.com/protected',
            'client',
            FULL_ACCESS_SCOPE,
            config.emailSecret,
            config.emailExpirationSeconds,
        );

        const response = await app.inject({
            method: 'POST',
            url: '/verify-email',
            headers: {
                accept: 'application/json',
                'content-type': 'application/json',
                origin: 'https://attacker.example.com',
            },
            payload: JSON.stringify({ token }),
        });

        expect(response.statusCode).toBe(403);
        expect(response.json()).toEqual({ message: 'Invalid or missing CSRF token' });
    });

    it('returns an access token that cannot be reused on a different site origin', async () => {
        const config = createTestConfig();
        const clientSite = config.sites[0];
        if (typeof clientSite === 'undefined') {
            throw new Error('Expected the test config to include a client site.');
        }
        config.sites = [
            ...config.sites,
            {
                id: 'admin',
                origins: new Set(['http://admin.example.com']),
                allowedRedirectUris: createAllowedRedirectUris(['http://admin.example.com/*']),
                accessRules: clientSite.accessRules,
                hostedAuthBranding: clientSite.hostedAuthBranding,
                hostedAuthPageCopy: clientSite.hostedAuthPageCopy,
            },
        ];
        const app = await createTestApp({ config });
        const token = await generateEmailToken(
            'allowed@example.com',
            'http://client.example.com/protected',
            'client',
            FULL_ACCESS_SCOPE,
            config.emailSecret,
            config.emailExpirationSeconds,
        );

        const response = await app.inject({
            method: 'POST',
            url: '/verify-email',
            headers: {
                'content-type': 'application/json',
            },
            payload: JSON.stringify({ token }),
        });

        expect(response.statusCode).toBe(200);
        const body = z
            .object({
                accessToken: z.string(),
            })
            .parse(response.json());

        expect(
            await verifyAccessToken(body.accessToken, config.jwtSecret, {
                expectedAudience: 'http://admin.example.com',
                expectedIssuer: new URL(config.appUrl).origin,
            }),
        ).toBeNull();
    });

    it('returns an error for invalid verification tokens', async () => {
        const response = await app.inject({
            method: 'POST',
            url: '/verify-email',
            headers: {
                'content-type': 'application/json',
            },
            payload: JSON.stringify({ token: 'invalid-token' }),
        });

        expect(response.statusCode).toBe(400);
        expect(response.json()).toEqual({ message: 'Invalid or expired token' });
    });

    it('logs JWT verification failures without logging the raw token', async () => {
        let logs = '';
        const logStream = new PassThrough();
        logStream.setEncoding('utf8');
        logStream.on('data', (chunk: string) => {
            logs += chunk;
        });
        const loggedApp = await createTestApp({
            config: {
                verifyTokenStoreDir,
            },
            logger: {
                level: 'info',
                stream: logStream,
            },
        });

        try {
            const response = await loggedApp.inject({
                method: 'POST',
                url: '/verify-email',
                headers: {
                    'content-type': 'application/json',
                },
                payload: JSON.stringify({ token: 'bad.jwt.token' }),
            });

            expect(response.statusCode).toBe(400);
            await waitForLogFlush();
            const verificationLogLine = logs
                .split('\n')
                .find((line) => line.includes('"msg":"Rejected verification token"'));
            expect(verificationLogLine).toContain('"jwtError":"JsonWebTokenError"');
            expect(verificationLogLine).not.toContain('bad.jwt.token');
        } finally {
            await loggedApp.close();
        }
    });

    it('rejects replayed verification tokens for programmatic requests', async () => {
        const token = await generateEmailToken(
            'allowed@example.com',
            'http://client.example.com/protected',
            'client',
            FULL_ACCESS_SCOPE,
            config.emailSecret,
            config.emailExpirationSeconds,
        );

        const firstResponse = await app.inject({
            method: 'POST',
            url: '/verify-email',
            headers: {
                'content-type': 'application/json',
            },
            payload: JSON.stringify({ token }),
        });

        const secondResponse = await app.inject({
            method: 'POST',
            url: '/verify-email',
            headers: {
                'content-type': 'application/json',
            },
            payload: JSON.stringify({ token }),
        });

        expect(firstResponse.statusCode).toBe(200);
        expect(secondResponse.statusCode).toBe(400);
        expect(secondResponse.json()).toEqual({ message: 'Invalid or expired token' });
    });

    it('rejects replayed verification tokens after an app restart when using the file store', async () => {
        const firstApp = await buildApp({
            config,
            logger: false,
            mailer: {
                async sendVerificationEmail(): Promise<void> {
                    return undefined;
                },
            },
        });
        const secondApp = await buildApp({
            config,
            logger: false,
            mailer: {
                async sendVerificationEmail(): Promise<void> {
                    return undefined;
                },
            },
        });
        let firstAppClosed = false;
        const token = await generateEmailToken(
            'allowed@example.com',
            'http://client.example.com/protected',
            'client',
            FULL_ACCESS_SCOPE,
            config.emailSecret,
            config.emailExpirationSeconds,
        );

        try {
            const firstResponse = await firstApp.inject({
                method: 'POST',
                url: '/verify-email',
                headers: {
                    'content-type': 'application/json',
                },
                payload: JSON.stringify({ token }),
            });

            expect(firstResponse.statusCode).toBe(200);

            await firstApp.close();
            firstAppClosed = true;

            const secondResponse = await secondApp.inject({
                method: 'POST',
                url: '/verify-email',
                headers: {
                    'content-type': 'application/json',
                },
                payload: JSON.stringify({ token }),
            });

            expect(secondResponse.statusCode).toBe(400);
            expect(secondResponse.json()).toEqual({ message: 'Invalid or expired token' });
        } finally {
            if (!firstAppClosed) {
                await firstApp.close();
            }
            await secondApp.close();
        }
    });

    it('rejects untrusted return URLs during browser verification', async () => {
        const token = await generateEmailToken(
            'allowed@example.com',
            'https://attacker.example.com/steal-session',
            'client',
            FULL_ACCESS_SCOPE,
            config.emailSecret,
            config.emailExpirationSeconds,
        );

        const response = await app.inject({
            method: 'GET',
            url: `/verify-email?token=${encodeURIComponent(token)}`,
            headers: {
                accept: 'text/html',
            },
        });

        expect(response.statusCode).toBe(400);
        expect(response.headers['content-type']).toContain('text/html');
        expect(response.body).toContain('Invalid or untrusted return URL');
    });

    it('rejects verification tokens whose return URL belongs to a different site', async () => {
        const primarySite = config.sites[0];
        if (typeof primarySite === 'undefined') {
            throw new Error('Expected a default site in test config.');
        }
        const multiSiteApp = await createTestApp({
            config: {
                sites: [
                    {
                        ...primarySite,
                    },
                    {
                        id: 'admin',
                        origins: new Set(['http://admin.example.com']),
                        allowedRedirectUris: createAllowedRedirectUris([
                            'http://admin.example.com/*',
                        ]),
                        accessRules: createAccessRules({
                            'admin@example.com': [FULL_ACCESS_SCOPE],
                        }),
                        hostedAuthBranding: createDefaultHostedAuthBranding(),
                        hostedAuthPageCopy: createDefaultHostedAuthPageCopy(),
                    },
                ],
            },
        });

        const token = await generateEmailToken(
            'allowed@example.com',
            'http://admin.example.com/dashboard',
            'client',
            FULL_ACCESS_SCOPE,
            config.emailSecret,
            config.emailExpirationSeconds,
        );

        try {
            const response = await multiSiteApp.inject({
                method: 'POST',
                url: '/verify-email',
                headers: {
                    'content-type': 'application/json',
                },
                payload: JSON.stringify({ token }),
            });

            expect(response.statusCode).toBe(400);
            expect(response.json()).toEqual({ message: 'Invalid or untrusted return URL' });
        } finally {
            await multiSiteApp.close();
        }
    });

    it('renders a browser verification handoff page for HTML requests', async () => {
        const token = await generateEmailToken(
            'allowed@example.com',
            'http://client.example.com/protected',
            'client',
            FULL_ACCESS_SCOPE,
            config.emailSecret,
            config.emailExpirationSeconds,
        );

        const response = await app.inject({
            method: 'GET',
            url: `/verify-email?token=${encodeURIComponent(token)}`,
            headers: {
                accept: 'text/html',
            },
        });

        expect(response.statusCode).toBe(200);
        expect(response.headers['content-type']).toContain('text/html');
        expect(response.headers['cache-control']).toBe('no-store');
        expect(response.headers['content-security-policy']).toContain("form-action 'self'");
        expect(response.headers['referrer-policy']).toBe('no-referrer');
        expect(response.body).toContain('<form id="verifyForm"');
        expect(response.body).toContain('method="post" action="/verify-email"');
        expect(extractHiddenInputValue(response.body, 'csrfToken')).not.toBe('');
        expect(response.body).not.toContain('name="token"');
        expect(response.body).toContain('allowed@example.com');
        expect(response.body).toContain('>Email<');
        expect(response.body).toContain('<button type="submit">Continue</button>');
        expect(response.body).toContain("window.history.replaceState(null, '', '/verify-email');");
        expect(response.body).not.toContain('form.submit()');
        expect(
            getSetCookieHeaders(response).some((cookie) =>
                cookie.startsWith(`${config.cookieName}.verify-email-token=`),
            ),
        ).toBe(true);
    });

    it('renders localized hosted verify-email text overrides', async () => {
        const localizedCopy = createDefaultHostedAuthPageCopy();
        localizedCopy.lang = 'pl';
        localizedCopy.verifyEmail.pageTitle = 'Potwierdz adres e-mail';
        localizedCopy.verifyEmail.title = 'Magia logowania';
        localizedCopy.verifyEmail.helpText =
            'Sprawdź adres e-mail poniżej, a potem kliknij przycisk, aby dokończyć logowanie.';
        localizedCopy.verifyEmail.continueButton = 'Kontynuuj';
        localizedCopy.verifyEmail.emailLabel = 'Adres e-mail';

        const localizedApp = await createTestApp({
            config: {
                hostedAuthPageCopy: localizedCopy,
                verifyTokenStoreDir,
            },
        });

        try {
            const token = await generateEmailToken(
                'allowed@example.com',
                'http://client.example.com/protected',
                'client',
                FULL_ACCESS_SCOPE,
                config.emailSecret,
                config.emailExpirationSeconds,
            );

            const response = await localizedApp.inject({
                method: 'GET',
                url: `/verify-email?token=${encodeURIComponent(token)}`,
                headers: {
                    accept: 'text/html',
                },
            });

            expect(response.statusCode).toBe(200);
            expect(response.body).toContain('<html lang="pl">');
            expect(response.body).toContain('<title>Potwierdz adres e-mail</title>');
            expect(response.body).toContain('Magia logowania');
            expect(response.body).toContain(
                'Sprawdź adres e-mail poniżej, a potem kliknij przycisk, aby dokończyć logowanie.',
            );
            expect(response.body).toContain('Kontynuuj');
            expect(response.body).toContain('Adres e-mail');
        } finally {
            await localizedApp.close();
        }
    });

    it('renders hosted verify-email branding hooks', async () => {
        const branding = createDefaultHostedAuthBranding();
        branding.title = 'Acme Cloud';
        branding.logoText = 'Acme Identity Platform';
        branding.supportText = 'Questions?';
        branding.supportLinkText = 'Open support';
        branding.supportLinkUrl = '/support';
        branding.verifyEmailCssVariables['--color-card-background'] = '#101820';

        const brandedApp = await createTestApp({
            config: {
                hostedAuthBranding: branding,
                verifyTokenStoreDir,
            },
        });

        try {
            const token = await generateEmailToken(
                'allowed@example.com',
                'http://client.example.com/protected',
                'client',
                FULL_ACCESS_SCOPE,
                config.emailSecret,
                config.emailExpirationSeconds,
            );

            const response = await brandedApp.inject({
                method: 'GET',
                url: `/verify-email?token=${encodeURIComponent(token)}`,
                headers: {
                    accept: 'text/html',
                },
            });

            expect(response.statusCode).toBe(200);
            expect(response.body).toContain('Acme Cloud');
            expect(response.body).toContain('Acme Identity Platform');
            expect(response.body).toContain('brand-mark--text');
            expect(response.body).toContain('background: none;');
            expect(response.body).toContain('text-transform: none;');
            expect(response.body).toContain('Questions?');
            expect(response.body).toContain('href="/support"');
            expect(response.body).toContain('--color-card-background: #101820;');
        } finally {
            await brandedApp.close();
        }
    });

    it('hides the hosted verify-email eyebrow when logo text matches the brand title', async () => {
        const branding = createDefaultHostedAuthBranding();
        branding.title = 'Acme Cloud';
        branding.logoText = 'Acme Cloud';

        const brandedApp = await createTestApp({
            config: {
                hostedAuthBranding: branding,
                verifyTokenStoreDir,
            },
        });

        try {
            const token = await generateEmailToken(
                'allowed@example.com',
                'http://client.example.com/protected',
                'client',
                FULL_ACCESS_SCOPE,
                config.emailSecret,
                config.emailExpirationSeconds,
            );

            const response = await brandedApp.inject({
                method: 'GET',
                url: `/verify-email?token=${encodeURIComponent(token)}`,
                headers: {
                    accept: 'text/html',
                },
            });

            expect(response.statusCode).toBe(200);
            expect(response.body).toContain('brand-lockup--standalone');
            expect(response.body).toContain('<span class="brand-mark-text">Acme Cloud</span>');
            expect(response.body).not.toContain('<p class="eyebrow">Acme Cloud</p>');
        } finally {
            await brandedApp.close();
        }
    });

    it('sets the auth cookie and redirects for browser verification POST requests', async () => {
        const token = await generateEmailToken(
            'allowed@example.com',
            'http://client.example.com/protected',
            'client',
            FULL_ACCESS_SCOPE,
            config.emailSecret,
            config.emailExpirationSeconds,
        );
        const { cookieHeader, csrfToken } = await getVerifyEmailFormSecurityContext(app, token);

        const response = await app.inject({
            method: 'POST',
            url: '/verify-email',
            headers: {
                'content-type': 'application/x-www-form-urlencoded',
                accept: 'text/html',
                cookie: cookieHeader,
            },
            payload: `csrfToken=${encodeURIComponent(csrfToken)}`,
        });

        expect(response.statusCode).toBe(302);
        expect(response.headers.location).toBe('http://client.example.com/protected');
        expect(response.headers['cache-control']).toBe('no-store');

        const cookies = getSetCookieHeaders(response);
        expect(cookies.some((cookie) => cookie.startsWith('magic-sso='))).toBe(true);
        expect(
            cookies.some((cookie) => cookie.startsWith(`${config.cookieName}.verify-email-token=`)),
        ).toBe(true);
        expect(
            cookies.some(
                (cookie) =>
                    cookie.startsWith(`${config.cookieName}.verify-email-token=`) &&
                    (cookie.includes('Max-Age=0') || cookie.includes('Expires=')),
            ),
        ).toBe(true);
        expect(cookies.some((cookie) => cookie.includes('HttpOnly'))).toBe(true);
        expect(cookies.some((cookie) => cookie.includes('SameSite=Lax'))).toBe(true);
    });

    it('allows the browser handoff GET before consuming the token on POST', async () => {
        const token = await generateEmailToken(
            'allowed@example.com',
            'http://client.example.com/protected',
            'client',
            FULL_ACCESS_SCOPE,
            config.emailSecret,
            config.emailExpirationSeconds,
        );
        const { cookieHeader, csrfToken, responseBody } = await getVerifyEmailFormSecurityContext(
            app,
            token,
        );
        const firstPostResponse = await app.inject({
            method: 'POST',
            url: '/verify-email',
            headers: {
                'content-type': 'application/x-www-form-urlencoded',
                accept: 'text/html',
                cookie: cookieHeader,
            },
            payload: `csrfToken=${encodeURIComponent(csrfToken)}`,
        });
        const secondPostResponse = await app.inject({
            method: 'POST',
            url: '/verify-email',
            headers: {
                'content-type': 'application/x-www-form-urlencoded',
                accept: 'text/html',
                cookie: cookieHeader,
            },
            payload: `csrfToken=${encodeURIComponent(csrfToken)}`,
        });

        expect(responseBody).not.toContain('name="token"');
        const firstCookies = getSetCookieHeaders(firstPostResponse);
        expect(firstCookies.some((cookie) => cookie.startsWith('magic-sso='))).toBe(true);
        expect(
            firstCookies.some((cookie) =>
                cookie.startsWith(`${config.cookieName}.verify-email-token=`),
            ),
        ).toBe(true);
        expect(firstCookies.some((cookie) => cookie.includes('Max-Age=0'))).toBe(true);
        expect(firstPostResponse.statusCode).toBe(302);
        expect(secondPostResponse.statusCode).toBe(400);
        expect(secondPostResponse.body).toContain('Invalid or expired token');
    });

    it('rejects browser verification requests with an invalid csrf token', async () => {
        const token = await generateEmailToken(
            'allowed@example.com',
            'http://client.example.com/protected',
            'client',
            FULL_ACCESS_SCOPE,
            config.emailSecret,
            config.emailExpirationSeconds,
        );
        const { cookieHeader } = await getVerifyEmailFormSecurityContext(app, token);

        const response = await app.inject({
            method: 'POST',
            url: '/verify-email',
            headers: {
                'content-type': 'application/x-www-form-urlencoded',
                accept: 'text/html',
                cookie: cookieHeader,
            },
            payload: `csrfToken=invalid`,
        });

        expect(response.statusCode).toBe(403);
        expect(response.body).toContain('Invalid request');
    });

    it('uses the configured cookie options during browser verification', async () => {
        const configuredApp = await createTestApp({
            config: {
                cookieDomain: 'example.com',
                cookiePath: '/auth',
                cookieSameSite: 'strict',
                cookieSecure: true,
            },
        });
        const token = await generateEmailToken(
            'allowed@example.com',
            undefined,
            'client',
            FULL_ACCESS_SCOPE,
            config.emailSecret,
            config.emailExpirationSeconds,
        );

        try {
            const { cookieHeader, csrfToken } = await getVerifyEmailFormSecurityContext(
                configuredApp,
                token,
            );
            const response = await configuredApp.inject({
                method: 'POST',
                url: '/verify-email',
                headers: {
                    'content-type': 'application/x-www-form-urlencoded',
                    accept: 'text/html',
                    cookie: cookieHeader,
                },
                payload: `csrfToken=${encodeURIComponent(csrfToken)}`,
            });

            expect(response.statusCode).toBe(302);
            expect(response.headers.location).toBe('/');

            const cookie = getSetCookieHeaders(response).find((value) =>
                value.startsWith('magic-sso='),
            );
            if (typeof cookie !== 'string') {
                throw new Error('Expected the auth cookie in the verify-email response.');
            }

            expect(cookie).toContain('Domain=example.com');
            expect(cookie).toContain('Path=/auth');
            expect(cookie).toContain('SameSite=Strict');
            expect(cookie).toContain('Secure');
        } finally {
            await configuredApp.close();
        }
    });

    it('renders an HTML error page for GET /verify-email without a token parameter', async () => {
        const response = await app.inject({
            method: 'GET',
            url: '/verify-email',
            headers: {
                accept: 'text/html',
            },
        });

        expect(response.statusCode).toBe(400);
        expect(response.headers['content-type']).toContain('text/html');
        expect(response.body).toContain('Invalid or expired token');
    });

    it('returns a JSON error for GET /verify-email without a token parameter', async () => {
        const response = await app.inject({
            method: 'GET',
            url: '/verify-email',
            headers: {
                accept: 'application/json',
            },
        });

        expect(response.statusCode).toBe(400);
        expect(response.headers['cache-control']).toBe('no-store');
        expect(response.headers.pragma).toBe('no-cache');
        expect(response.json()).toEqual({ message: 'Invalid or expired token' });
    });

    it('returns a forbidden JSON error for GET /verify-email without the preview secret', async () => {
        const token = await generateEmailToken(
            'allowed@example.com',
            'http://client.example.com/protected',
            'client',
            FULL_ACCESS_SCOPE,
            config.emailSecret,
            config.emailExpirationSeconds,
        );

        const previewResponse = await app.inject({
            method: 'GET',
            url: `/verify-email?token=${encodeURIComponent(token)}`,
            headers: {
                accept: 'application/json',
            },
        });

        expect(previewResponse.statusCode).toBe(403);
        expect(previewResponse.headers['cache-control']).toBe('no-store');
        expect(previewResponse.headers.pragma).toBe('no-cache');
        expect(previewResponse.json()).toEqual({ message: 'Forbidden' });
    });

    it('returns the verified email without consuming the token on GET /verify-email', async () => {
        const token = await generateEmailToken(
            'allowed@example.com',
            'http://client.example.com/protected',
            'client',
            FULL_ACCESS_SCOPE,
            config.emailSecret,
            config.emailExpirationSeconds,
        );

        const previewResponse = await app.inject({
            method: 'GET',
            url: `/verify-email?token=${encodeURIComponent(token)}`,
            headers: {
                accept: 'application/json',
                'x-magic-sso-preview-secret': config.previewSecret,
            },
        });

        expect(previewResponse.statusCode).toBe(200);
        expect(previewResponse.headers['cache-control']).toBe('no-store');
        expect(previewResponse.headers.pragma).toBe('no-cache');
        expect(previewResponse.json()).toEqual({ email: 'allowed@example.com' });

        const verifyResponse = await app.inject({
            method: 'POST',
            url: '/verify-email',
            headers: {
                'content-type': 'application/json',
            },
            payload: JSON.stringify({ token }),
        });

        expect(verifyResponse.statusCode).toBe(200);
        expect(verifyResponse.headers['cache-control']).toBe('no-store');
        expect(verifyResponse.headers.pragma).toBe('no-cache');
        expect(verifyResponse.json()).toHaveProperty('accessToken');
    });

    it('returns a 404 for GET /verify-email/preview', async () => {
        const response = await app.inject({
            method: 'GET',
            url: '/verify-email/preview',
            headers: {
                accept: 'application/json',
            },
        });

        expect(response.statusCode).toBe(404);
    });

    it('returns a JSON error for POST /verify-email with JSON content and a missing token', async () => {
        const response = await app.inject({
            method: 'POST',
            url: '/verify-email',
            headers: {
                'content-type': 'application/json',
            },
            payload: JSON.stringify({ notAToken: 'value' }),
        });

        expect(response.statusCode).toBe(400);
        expect(response.json()).toEqual({ message: 'Invalid or expired token' });
    });

    it('scrubs unexpected route errors through the global error handler', async () => {
        const errorApp = await createTestApp({
            config: {
                ...createTestConfig(),
            },
        });

        errorApp.get('/boom', async (): Promise<void> => {
            throw new Error('boom leaked');
        });

        try {
            const jsonResponse = await errorApp.inject({
                headers: {
                    accept: 'application/json',
                },
                method: 'GET',
                url: '/boom',
            });

            expect(jsonResponse.statusCode).toBe(500);
            expect(jsonResponse.json()).toEqual({ message: 'Internal Server Error' });
            expect(jsonResponse.body).not.toContain('boom leaked');

            const htmlResponse = await errorApp.inject({
                headers: {
                    accept: 'text/html',
                },
                method: 'GET',
                url: '/boom',
            });

            expect(htmlResponse.statusCode).toBe(500);
            expect(htmlResponse.headers['content-type']).toContain('text/html');
            expect(htmlResponse.body).toContain('Internal Server Error');
            expect(htmlResponse.body).not.toContain('boom leaked');
        } finally {
            await errorApp.close();
        }
    });

    it('allows an HTML POST /verify-email request with a valid CSRF token and no token field', async () => {
        const token = await generateEmailToken(
            'allowed@example.com',
            'http://client.example.com/protected',
            'client',
            FULL_ACCESS_SCOPE,
            config.emailSecret,
            config.emailExpirationSeconds,
        );
        const { cookieHeader, csrfToken } = await getVerifyEmailFormSecurityContext(app, token);

        const response = await app.inject({
            method: 'POST',
            url: '/verify-email',
            headers: {
                'content-type': 'application/x-www-form-urlencoded',
                accept: 'text/html',
                cookie: cookieHeader,
            },
            payload: `csrfToken=${encodeURIComponent(csrfToken)}`,
        });

        expect(response.statusCode).toBe(302);
        expect(response.headers.location).toBe('http://client.example.com/protected');
    });

    it('prefers the last duplicate verify-email token cookie during browser verification', async () => {
        const validToken = await generateEmailToken(
            'allowed@example.com',
            'http://client.example.com/protected',
            'client',
            FULL_ACCESS_SCOPE,
            config.emailSecret,
            config.emailExpirationSeconds,
        );
        const staleToken = 'stale-token';
        const { cookieHeader, csrfToken } = await getVerifyEmailFormSecurityContext(
            app,
            validToken,
        );
        const duplicateCookieHeader =
            `${cookieHeader}; ${config.cookieName}.verify-email-token=${encodeURIComponent(staleToken)}; ` +
            `${config.cookieName}.verify-email-token=${encodeURIComponent(validToken)}`;

        const response = await app.inject({
            method: 'POST',
            url: '/verify-email',
            headers: {
                'content-type': 'application/x-www-form-urlencoded',
                accept: 'text/html',
                cookie: duplicateCookieHeader,
            },
            payload: `csrfToken=${encodeURIComponent(csrfToken)}`,
        });

        expect(response.statusCode).toBe(302);
        expect(response.headers.location).toBe('http://client.example.com/protected');
    });
});
