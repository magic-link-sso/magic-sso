// SPDX-License-Identifier: GPL-3.0-or-later
import { createHash, randomUUID } from 'node:crypto';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { FastifyInstance, LightMyRequestResponse } from 'fastify';
import { z } from 'zod';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { buildApp } from './app.js';
import { parseMagicSsoConfigToml, type AppConfig } from './config.js';
import { generateEmailToken, verifyAccessToken, verifyEmailToken } from './auth.js';
import * as authModule from './auth.js';
import { createBrowserSsoOpaqueValue } from './browserSsoStore.js';
import { createSecurityState, type SharedSecurityState } from './securityState.js';
import type { VerificationEmailInput } from './email.js';

const issuer = 'https://sso.example.com';
const verifier = 'dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk';
const codeChallenge = createHash('sha256').update(verifier).digest('base64url');

function hidden(body: string, name: string): string {
    const value = body.match(new RegExp(`name="${name}" value="([^"]+)"`))?.[1];
    if (!value) {
        throw new Error(`Missing ${name}: ${body.slice(-1000)}`);
    }
    return value.replaceAll('&amp;', '&').replaceAll('&#34;', '"').replaceAll('&#39;', "'");
}

class Browser {
    readonly cookies: Map<string, string> = new Map();
    constructor(private readonly app: FastifyInstance) {}
    private remember(response: LightMyRequestResponse): LightMyRequestResponse {
        for (const cookie of response.cookies) {
            if (cookie.value === '' || cookie.maxAge === 0) {
                this.cookies.delete(cookie.name);
            } else {
                this.cookies.set(cookie.name, cookie.value);
            }
        }
        return response;
    }
    async get(url: string, accept = 'text/html'): Promise<LightMyRequestResponse> {
        return this.remember(
            await this.app.inject({
                method: 'GET',
                url,
                cookies: Object.fromEntries(this.cookies),
                headers: { accept },
            }),
        );
    }
    async post(
        url: string,
        payload: Record<string, string>,
        origin = issuer,
    ): Promise<LightMyRequestResponse> {
        return this.remember(
            await this.app.inject({
                method: 'POST',
                url,
                cookies: Object.fromEntries(this.cookies),
                headers: {
                    accept: 'text/html',
                    origin,
                    'content-type': 'application/x-www-form-urlencoded',
                },
                payload: new URLSearchParams(payload).toString(),
            }),
        );
    }
}

describe(`browser SSO issuer HTTP flow (${process.env.MAGICSSO_TEST_REDIS_URL ? 'Redis' : 'file'})`, () => {
    let directory: string;
    let config: AppConfig;
    let app: FastifyInstance;
    let state: SharedSecurityState;
    let browser: Browser;
    let emails: VerificationEmailInput[];
    let logs: string[];

    beforeEach(async () => {
        directory = await mkdtemp(join(tmpdir(), 'magic-sso-issuer-'));
        const fixture = await readFile(
            new URL('../../packages/config-core/src/browser-sso.fixture.toml', import.meta.url),
            'utf8',
        );
        config = parseMagicSsoConfigToml(
            fixture.replace('enabled = false', 'enabled = true'),
            'fixture',
        );
        config.verifyTokenStoreDir = join(directory, 'tokens');
        config.signInEmailRateLimitStoreDir = join(directory, 'limits');
        if (process.env.MAGICSSO_TEST_REDIS_URL) {
            config.securityState = {
                adapter: 'redis',
                redisUrl: process.env.MAGICSSO_TEST_REDIS_URL,
                keyPrefix: `magic-sso-issuer-test-${randomUUID()}`,
            };
        }
        config.signInPageRateLimitMax = 200;
        config.signInRateLimitMax = 200;
        config.verifyRateLimitMax = 200;
        config.signInEmailRateLimitMax = 200;
        config.otp = {
            ...config.otp,
            enabled: true,
            secret: 'fixture-otp-secret-012345678901234567890',
        };
        const first = config.sites[0];
        if (!first) {
            throw new Error('Missing first site');
        }
        first.accessRules.set('other@example.com', new Set(['*']));
        config.sites.push({
            ...structuredClone(first),
            id: 'second',
            origins: new Set(['https://other.test']),
            sso: [
                {
                    redirectUri: 'https://other.test/sso/callback',
                    startUri: 'https://other.test/sso/start',
                    signedOutUri: 'https://other.test/signed-out',
                },
            ],
        });
        state = await createSecurityState(config);
        emails = [];
        logs = [];
        app = await buildApp({
            config,
            securityState: state,
            logger: {
                level: 'info',
                stream: {
                    write(chunk: string): void {
                        logs.push(chunk);
                    },
                },
            },
            mailer: {
                async sendVerificationEmail(input): Promise<void> {
                    emails.push(input);
                },
            },
        });
        browser = new Browser(app);
    });
    afterEach(async () => {
        vi.restoreAllMocks();
        await app?.close();
        await rm(directory, { force: true, recursive: true });
    });

    function authorizeUrl(site = 'app', options: Record<string, string> = {}): string {
        return `/sso/authorize?${new URLSearchParams({
            redirectUri:
                site === 'app'
                    ? 'https://app.example.com/sso/callback'
                    : 'https://other.test/sso/callback',
            state: createBrowserSsoOpaqueValue(),
            codeChallenge,
            codeChallengeMethod: 'S256',
            ...options,
        })}`;
    }
    async function start(
        target = browser,
        site = 'app',
        options: Record<string, string> = {},
    ): Promise<{ requestId: string; csrfToken: string; page: LightMyRequestResponse }> {
        const page = await target.get(authorizeUrl(site, options));
        expect(page.statusCode).toBe(200);
        return {
            requestId: hidden(page.body, 'requestId'),
            csrfToken: hidden(page.body, 'csrfToken'),
            page,
        };
    }
    async function send(
        target = browser,
        email = 'owner@example.com',
        site = 'app',
        options: Record<string, string> = {},
    ): Promise<{ requestId: string; page: LightMyRequestResponse; email: VerificationEmailInput }> {
        const started = await start(target, site, options);
        const page = await target.post('/sso/signin', {
            requestId: started.requestId,
            csrfToken: started.csrfToken,
            email,
        });
        expect(page.statusCode).toBe(200);
        const sent = emails.at(-1);
        if (!sent) {
            throw new Error('Missing email');
        }
        return { requestId: started.requestId, page, email: sent };
    }
    async function confirm(
        sent: { requestId: string; email: VerificationEmailInput },
        target = browser,
    ): Promise<LightMyRequestResponse> {
        const url = new URL(sent.email.verifyUrl);
        url.searchParams.set('token', sent.email.token);
        const page = await target.get(url.pathname + url.search);
        expect(page.statusCode).toBe(200);
        return target.post('/sso/verify', {
            requestId: sent.requestId,
            token: sent.email.token,
            csrfToken: hidden(page.body, 'csrfToken'),
        });
    }
    async function exchange(
        response: LightMyRequestResponse,
        overrides: Record<string, string> = {},
    ): Promise<LightMyRequestResponse> {
        const callback = new URL(response.headers.location ?? 'https://missing.invalid');
        return app.inject({
            method: 'POST',
            url: '/sso/exchange',
            payload: {
                code: callback.searchParams.get('code'),
                codeVerifier: verifier,
                redirectUri: callback.origin + callback.pathname,
                ...overrides,
            },
        });
    }
    async function accessToken(response: LightMyRequestResponse): Promise<string> {
        expect(response.statusCode).toBe(200);
        return z.object({ accessToken: z.string() }).parse(response.json()).accessToken;
    }
    function central(target = browser): string | undefined {
        return target.cookies.get('__Host-magic-sso-browser');
    }

    it.each(['link', 'otp'])(
        'enters two sites after one hosted %s verification with independent JWT audiences',
        async (method) => {
            const sent = await send();
            expect(sent.page.headers['content-security-policy']).toContain(
                "form-action 'self' https://app.example.com",
            );
            let completed: LightMyRequestResponse;
            if (method === 'link') {
                completed = await confirm(sent);
            } else {
                completed = await browser.post('/sso/otp', {
                    requestId: sent.requestId,
                    challengeId: hidden(sent.page.body, 'challengeId'),
                    otpContext: hidden(sent.page.body, 'otpContext'),
                    code: sent.email.otpCode ?? '',
                    csrfToken: hidden(sent.page.body, 'csrfToken'),
                });
            }
            expect(completed.statusCode).toBe(303);
            const firstToken = await accessToken(await exchange(completed));
            const second = await browser.get(authorizeUrl('second'));
            expect(second.statusCode).toBe(302);
            const secondToken = await accessToken(await exchange(second));
            expect(emails).toHaveLength(1);
            const first = await verifyAccessToken(firstToken, config.jwtSecret, {
                expectedIssuer: issuer,
                expectedAudience: 'https://app.example.com',
            });
            const other = await verifyAccessToken(secondToken, config.jwtSecret, {
                expectedIssuer: issuer,
                expectedAudience: 'https://other.test',
            });
            expect(first).toMatchObject({ email: 'owner@example.com', siteId: 'app' });
            expect(other).toMatchObject({ email: 'owner@example.com', siteId: 'second' });
            expect(
                await verifyAccessToken(firstToken, config.jwtSecret, {
                    expectedAudience: 'https://other.test',
                }),
            ).toBeNull();
            const handle = central();
            if (!handle) {
                throw new Error('Missing central session');
            }
            const session = await state.browserSsoStore.getSession(handle, Date.now());
            expect((other?.exp ?? Infinity) * 1000).toBeLessThanOrEqual(session?.expiresAt ?? 0);
            expect(
                completed.cookies.find((entry) => entry.name === '__Host-magic-sso-browser'),
            ).toMatchObject({ secure: true, httpOnly: true, sameSite: 'Lax', path: '/' });
            expect(JSON.stringify(completed.headers['set-cookie'])).not.toContain('Domain=');
            expect(completed.cookies.some((entry) => entry.name === config.cookieName)).toBe(false);
        },
    );

    it('rejects unknown callbacks and malformed authorization fields without redirects', async () => {
        for (const options of [
            { redirectUri: 'https://evil.test/callback' },
            { codeChallengeMethod: 'plain' },
            { state: 'short' },
            { codeChallenge: 'short' },
            { scope: 'x'.repeat(257) },
            { scope: 'é'.repeat(129) },
        ]) {
            const response = await browser.get(authorizeUrl('app', options));
            expect(response.statusCode).toBe(400);
            expect(response.headers.location).toBeUndefined();
        }
        expect(emails).toHaveLength(0);
    });

    it('does not create a central session or consume a grant on GET or forged POST', async () => {
        const sent = await send();
        const url = new URL(sent.email.verifyUrl);
        url.searchParams.set('token', sent.email.token);
        const preview = await browser.get(url.pathname + url.search);
        expect(preview.statusCode).toBe(200);
        expect(central()).toBeUndefined();
        const body = {
            requestId: sent.requestId,
            token: sent.email.token,
            csrfToken: hidden(preview.body, 'csrfToken'),
        };
        expect((await browser.post('/sso/verify', body, 'https://evil.test')).statusCode).toBe(403);
        expect((await browser.post('/sso/verify', { ...body, csrfToken: 'bad' })).statusCode).toBe(
            403,
        );
        expect(central()).toBeUndefined();
        expect((await browser.post('/sso/verify', body)).statusCode).toBe(303);
        expect((await browser.post('/sso/verify', body)).statusCode).toBe(400);
    });

    it.each([
        { origin: 'null', site: 'same-origin', expected: 200 },
        { origin: undefined, site: 'same-origin', expected: 200 },
        { origin: 'null', site: 'cross-site', expected: 403 },
        { origin: 'null', site: 'same-site', expected: 403 },
        { origin: 'null', site: undefined, expected: 403 },
        { origin: 'https://evil.test', site: 'same-origin', expected: 403 },
    ])(
        'requires binding-derived CSRF plus trusted origin evidence: %j',
        async ({ origin, site, expected }) => {
            const started = await start();
            const response = await app.inject({
                method: 'POST',
                url: '/sso/signin',
                cookies: Object.fromEntries(browser.cookies),
                headers: {
                    'content-type': 'application/x-www-form-urlencoded',
                    accept: 'text/html',
                    ...(origin === undefined ? {} : { origin }),
                    ...(site === undefined ? {} : { 'sec-fetch-site': site }),
                },
                payload: new URLSearchParams({
                    requestId: started.requestId,
                    csrfToken: started.csrfToken,
                    email: 'owner@example.com',
                }).toString(),
            });
            expect(response.statusCode).toBe(expected);
            expect(emails).toHaveLength(expected === 200 ? 1 : 0);
        },
    );

    it('isolates legacy grants and browser SSO grants in both directions', async () => {
        const sent = await send();
        expect(await verifyEmailToken(sent.email.token, config.emailSecret)).toBeNull();
        const legacyVerification = await app.inject({
            method: 'POST',
            url: '/verify-email',
            payload: { token: sent.email.token },
        });
        expect(legacyVerification.statusCode).toBe(400);
        expect(legacyVerification.json()).not.toHaveProperty('accessToken');
        const legacy = await generateEmailToken(
            'owner@example.com',
            'https://app.example.com/',
            'app',
            '*',
            issuer,
            config.emailSecret,
            900,
        );
        const response = await browser.get(
            `/sso/verify?${new URLSearchParams({ requestId: sent.requestId, token: legacy })}`,
        );
        expect(response.statusCode).toBe(400);
        expect(central()).toBeUndefined();
        expect((await confirm(sent)).statusCode).toBe(303);
    });

    it('does not accept or consume a browser SSO OTP through the legacy endpoint', async () => {
        const sent = await send();
        const challengeId = hidden(sent.page.body, 'challengeId');
        const rejected = await app.inject({
            method: 'POST',
            url: '/verify-email/otp',
            payload: { challengeId, code: sent.email.otpCode },
        });
        expect(rejected.statusCode).toBe(400);
        expect(rejected.json()).not.toHaveProperty('accessToken');
        const completed = await browser.post('/sso/otp', {
            requestId: sent.requestId,
            challengeId,
            code: sent.email.otpCode ?? '',
            otpContext: hidden(sent.page.body, 'otpContext'),
            csrfToken: hidden(sent.page.body, 'csrfToken'),
        });
        expect(completed.statusCode).toBe(303);
    });

    it('does not consume a code on wrong verifier or callback and rejects replay', async () => {
        const response = await confirm(await send());
        expect((await exchange(response, { codeVerifier: 'x'.repeat(43) })).statusCode).toBe(400);
        expect(
            (await exchange(response, { redirectUri: 'https://other.test/sso/callback' }))
                .statusCode,
        ).toBe(400);
        expect((await exchange(response)).statusCode).toBe(200);
        expect((await exchange(response)).statusCode).toBe(400);
    });

    it('enforces current grants on reuse and again at exchange', async () => {
        const first = await confirm(await send());
        await exchange(first);
        const secondSite = config.sites[1];
        if (!secondSite) {
            throw new Error('Missing site');
        }
        const second = await browser.get(authorizeUrl('second'));
        secondSite.accessRules.delete('owner@example.com');
        expect((await exchange(second)).statusCode).toBe(403);
        const denied = await browser.get(authorizeUrl('second'));
        expect(denied.statusCode).toBe(403);
        expect(denied.body).toContain('prompt=login');
        expect(denied.headers.location).toBeUndefined();
        expect(emails).toHaveLength(1);
        secondSite.accessRules.set('owner@example.com', new Set(['*']));
        expect((await exchange(second)).statusCode).toBe(200);
    });

    it('rejects a grant removed while redemption is awaiting storage', async () => {
        const first = await confirm(await send());
        const original = state.browserSsoStore.redeemCode.bind(state.browserSsoStore);
        vi.spyOn(state.browserSsoStore, 'redeemCode').mockImplementation(async (input) => {
            const result = await original(input);
            config.sites[0]?.accessRules.delete('owner@example.com');
            return result;
        });
        expect((await exchange(first)).statusCode).toBe(403);
    });

    it.each(['session', 'request', 'code'])(
        'uses freshly reloaded grants after authorization %s storage awaits',
        async (phase) => {
            await confirm(await send());
            const removeGrant = (): void => {
                config.sites = config.sites.map((site) => {
                    const copy = structuredClone(site);
                    copy.accessRules.delete('owner@example.com');
                    return copy;
                });
            };
            if (phase === 'session') {
                const original = state.browserSsoStore.getSession.bind(state.browserSsoStore);
                vi.spyOn(state.browserSsoStore, 'getSession').mockImplementation(
                    async (handle, now) => {
                        const result = await original(handle, now);
                        removeGrant();
                        return result;
                    },
                );
            } else if (phase === 'request') {
                const original = state.browserSsoStore.createRequest.bind(state.browserSsoStore);
                vi.spyOn(state.browserSsoStore, 'createRequest').mockImplementation(
                    async (input) => {
                        const result = await original(input);
                        removeGrant();
                        return result;
                    },
                );
            } else {
                const original = state.browserSsoStore.issueCode.bind(state.browserSsoStore);
                vi.spyOn(state.browserSsoStore, 'issueCode').mockImplementation(async (input) => {
                    const result = await original(input);
                    removeGrant();
                    return result;
                });
            }
            const denied = await browser.get(authorizeUrl('second'));
            expect(denied.statusCode).toBe(403);
            expect(denied.headers.location).toBeUndefined();
            expect(denied.body).toContain('prompt=login');
        },
    );

    it('does not return a JWT if grants change during asynchronous signing', async () => {
        const completed = await confirm(await send());
        const original = authModule.signAccessToken;
        vi.spyOn(authModule, 'signAccessToken').mockImplementation(async (...args) => {
            const token = await original(...args);
            config.sites[0]?.accessRules.delete('owner@example.com');
            return token;
        });
        const denied = await exchange(completed);
        expect(denied.statusCode).toBe(403);
        expect(denied.json()).not.toHaveProperty('accessToken');
    });

    it('keeps OTP tabs independent and does not consume another tab challenge', async () => {
        const first = await send();
        const second = await send();
        const mismatched = await browser.post('/sso/otp', {
            requestId: first.requestId,
            challengeId: hidden(second.page.body, 'challengeId'),
            otpContext: hidden(second.page.body, 'otpContext'),
            code: second.email.otpCode ?? '',
            csrfToken: hidden(first.page.body, 'csrfToken'),
        });
        expect(mismatched.statusCode).toBe(403);
        const verified = await browser.post('/sso/otp', {
            requestId: second.requestId,
            challengeId: hidden(second.page.body, 'challengeId'),
            otpContext: hidden(second.page.body, 'otpContext'),
            code: second.email.otpCode ?? '',
            csrfToken: hidden(second.page.body, 'csrfToken'),
        });
        expect(verified.statusCode).toBe(303);
        expect((await confirm(first)).statusCode).toBe(303);
    });

    it('confirms an email in another browser without handing it the original callback code', async () => {
        const sent = await send();
        const otherBrowser = new Browser(app);
        const completed = await confirm(sent, otherBrowser);
        expect(completed.statusCode).toBe(200);
        expect(completed.headers.location).toBeUndefined();
        expect(completed.body).toContain('https://app.example.com/sso/start');
        expect(central(otherBrowser)).toBeDefined();
        expect(central()).toBeUndefined();
        const next = await otherBrowser.get(authorizeUrl());
        expect(next.statusCode).toBe(302);
        expect((await exchange(next)).statusCode).toBe(200);
        expect((await confirm(sent)).statusCode).toBe(400);
    });

    it('requires explicit account verification and invalidates old central codes without rewriting app JWTs', async () => {
        const first = await confirm(await send());
        const oldToken = await accessToken(await exchange(first));
        const oldHandle = central();
        const pendingOldCode = await browser.get(authorizeUrl('second'));
        const fresh = await send(browser, 'other@example.com', 'app', { prompt: 'login' });
        expect(central()).toBe(oldHandle);
        const changed = await confirm(fresh);
        expect(changed.statusCode).toBe(303);
        expect(central()).not.toBe(oldHandle);
        expect((await exchange(pendingOldCode)).statusCode).toBe(401);
        const token = await accessToken(await exchange(changed));
        expect(await verifyAccessToken(token, config.jwtSecret)).toMatchObject({
            email: 'other@example.com',
        });
        expect(await verifyAccessToken(oldToken, config.jwtSecret)).toMatchObject({
            email: 'owner@example.com',
        });
    });

    it('requires a same-origin CSRF POST for central sign-out and exact registered return URI', async () => {
        const first = await confirm(await send());
        const token = await accessToken(await exchange(first));
        const oldHandle = central();
        const pending = await browser.get(authorizeUrl('second'));
        const page = await browser.get(
            '/sso/signout?returnUri=https%3A%2F%2Fapp.example.com%2Fsigned-out',
        );
        expect(central()).toBe(oldHandle);
        const form = {
            csrfToken: hidden(page.body, 'csrfToken'),
            returnUri: 'https://app.example.com/signed-out',
        };
        expect((await browser.post('/sso/signout', form, 'https://evil.test')).statusCode).toBe(
            403,
        );
        expect(
            (await browser.post('/sso/signout', { ...form, returnUri: 'https://evil.test' }))
                .statusCode,
        ).toBe(400);
        const done = await browser.post('/sso/signout', form);
        expect(done.statusCode).toBe(303);
        expect(done.headers.location).toBe(form.returnUri);
        expect(central()).toBeUndefined();
        expect((await exchange(pending)).statusCode).toBe(401);
        expect(await verifyAccessToken(token, config.jwtSecret)).toMatchObject({
            email: 'owner@example.com',
        });
    });

    it('fails with 503 when storage is unavailable instead of quietly sending another email', async () => {
        await confirm(await send());
        vi.spyOn(state.browserSsoStore, 'getSession').mockRejectedValue(
            new Error('private-sensitive-store-error'),
        );
        const failed = await browser.get(authorizeUrl('second'), 'application/json');
        expect(failed.statusCode).toBe(503);
        expect(failed.json()).toMatchObject({ error: 'temporarily_unavailable' });
        expect(failed.body).not.toContain('private-sensitive');
        expect(emails).toHaveLength(1);
    });

    it('keeps requests fixed on resend and rejects rotated email links', async () => {
        const sent = await send();
        const before = await state.browserSsoStore.getRequest(sent.requestId, Date.now());
        const resent = await browser.post('/sso/signin', {
            requestId: sent.requestId,
            email: 'owner@example.com',
            csrfToken: hidden(sent.page.body, 'csrfToken'),
        });
        expect(resent.statusCode).toBe(200);
        const after = await state.browserSsoStore.getRequest(sent.requestId, Date.now());
        expect(after?.expiresAt).toBe(before?.expiresAt);
        const old = new URL(sent.email.verifyUrl);
        old.searchParams.set('token', sent.email.token);
        expect((await browser.get(old.pathname + old.search)).statusCode).toBe(400);
        const latest = emails.at(-1);
        if (!latest) {
            throw new Error('Missing latest email');
        }
        expect((await confirm({ requestId: sent.requestId, email: latest })).statusCode).toBe(303);
    });

    it('reuses central SSO after the shorter-lived binding cookie has disappeared', async () => {
        await confirm(await send());
        browser.cookies.delete('__Host-magic-sso-browser-binding');
        const response = await browser.get(authorizeUrl('second'));
        expect(response.statusCode).toBe(302);
        expect((await exchange(response)).statusCode).toBe(200);
        expect(emails).toHaveLength(1);
    });

    it('redacts protocol query values, email proofs and exchange secrets from automatic logs', async () => {
        const sent = await send();
        const completed = await confirm(sent);
        await exchange(completed);
        const output = logs.join('');
        expect(output).toContain('/sso/verify');
        expect(output).not.toContain(sent.email.token);
        expect(output).not.toContain(codeChallenge);
        expect(output).not.toContain(verifier);
        expect(output).not.toContain(
            new URL(completed.headers.location ?? '').searchParams.get('code'),
        );
        expect(output).not.toContain(central());
        expect(output).not.toContain('owner@example.com');
    });

    it('rejects expired request verification without creating central identity', async () => {
        const sent = await send();
        const pending = await state.browserSsoStore.getRequest(sent.requestId, Date.now());
        if (!pending) {
            throw new Error('Missing pending request');
        }
        const originalNow = Date.now;
        vi.spyOn(Date, 'now').mockReturnValue(pending.expiresAt);
        const url = new URL(sent.email.verifyUrl);
        url.searchParams.set('token', sent.email.token);
        expect((await browser.get(url.pathname + url.search)).statusCode).toBe(400);
        expect(central()).toBeUndefined();
        vi.mocked(Date.now).mockImplementation(originalNow);
    });

    it('never slides central expiry when entering another application', async () => {
        await confirm(await send());
        const handle = central();
        if (!handle) {
            throw new Error('Missing central handle');
        }
        const original = await state.browserSsoStore.getSession(handle, Date.now());
        if (!original) {
            throw new Error('Missing session');
        }
        const reused = await browser.get(authorizeUrl('second'));
        expect(reused.statusCode).toBe(302);
        expect((await state.browserSsoStore.getSession(handle, Date.now()))?.expiresAt).toBe(
            original.expiresAt,
        );
        vi.spyOn(Date, 'now').mockReturnValue(original.expiresAt);
        const expired = await browser.get(authorizeUrl('second'));
        expect(expired.statusCode).toBe(200);
        expect(expired.body).toContain('name="email"');
        expect(emails).toHaveLength(1);
    });

    function configureLauncher(): void {
        const [first, second] = config.sites;
        if (!first || !second) {
            throw new Error('Missing sites');
        }
        first.launcher = {
            name: 'Documents & reports',
            launchUrl: 'https://app.example.com/reports?q=a%2Bb&tag=one&tag=two',
            scope: '*',
        };
        second.launcher = {
            name: 'Private photos',
            launchUrl: 'https://other.test/albums',
            scope: 'photos',
        };
        second.accessRules.set('reader@example.com', new Set(['photos']));
        first.accessRules.set('reader@example.com', new Set(['reports']));
    }
    async function startLauncher(): Promise<LightMyRequestResponse> {
        const page = await browser.get('/sso/apps');
        const started = await browser.post('/sso/apps/signin', {
            csrfToken: hidden(page.body, 'csrfToken'),
        });
        expect(started.statusCode).toBe(303);
        return browser.get(started.headers.location ?? '');
    }
    async function sendLauncher(
        email = 'owner@example.com',
    ): Promise<{ requestId: string; page: LightMyRequestResponse; email: VerificationEmailInput }> {
        const started = await startLauncher();
        expect(started.statusCode).toBe(200);
        const requestId = hidden(started.body, 'requestId');
        const page = await browser.post('/sso/signin', {
            requestId,
            email,
            csrfToken: hidden(started.body, 'csrfToken'),
        });
        expect(page.statusCode).toBe(200);
        const sent = emails.at(-1);
        if (!sent) {
            throw new Error('Missing launcher email');
        }
        return { requestId, page, email: sent };
    }

    it('offers private launcher sign-in without exposing application names or links', async () => {
        configureLauncher();
        const page = await browser.get('/sso/apps');
        expect((await browser.get('/')).body).toContain('href="/sso/apps"');
        expect(page.statusCode).toBe(200);
        expect(page.body).toContain('My applications');
        expect(page.body).toContain('Sign in with your email');
        expect(page.body).not.toContain('Documents &amp; reports');
        expect(page.body).not.toContain('https://app.example.com');
        expect(page.headers['cache-control']).toBe('no-store');
        expect(page.headers['referrer-policy']).toBe('no-referrer');
        expect(page.headers['content-security-policy']).toContain("frame-ancestors 'none'");
        expect(page.headers['content-security-policy']).toContain("form-action 'self'");
        expect(central()).toBeUndefined();
    });

    it.each(['link', 'otp'])(
        'signs into the launcher with %s and reuses SSO without creating an app session',
        async (method) => {
            configureLauncher();
            const sent = await sendLauncher();
            let completed: LightMyRequestResponse;
            if (method === 'link') {
                completed = await confirm(sent);
                const page = await browser.get('/sso/apps');
                expect(
                    (
                        await browser.post('/sso/verify', {
                            requestId: sent.requestId,
                            token: sent.email.token,
                            csrfToken: hidden(page.body, 'csrfToken'),
                        })
                    ).statusCode,
                ).toBe(400);
            } else {
                completed = await browser.post('/sso/otp', {
                    requestId: sent.requestId,
                    csrfToken: hidden(sent.page.body, 'csrfToken'),
                    challengeId: hidden(sent.page.body, 'challengeId'),
                    otpContext: hidden(sent.page.body, 'otpContext'),
                    code: sent.email.otpCode ?? '',
                });
            }
            expect(completed.statusCode).toBe(303);
            expect(completed.headers.location).toBe('/sso/apps');
            expect(central()).toBeDefined();
            expect([...browser.cookies.keys()]).not.toContain(config.cookieName);
            const page = await browser.get('/sso/apps');
            expect(page.body).toContain('owner@example.com');
            expect(page.body).toContain('Documents &amp; reports');
            expect(page.body).toContain('Private photos');
            const href = page.body
                .match(/class="application" href="([^"]+)"/u)?.[1]
                ?.replaceAll('&amp;', '&');
            const start = new URL(href ?? 'https://missing.invalid');
            expect(start.origin + start.pathname).toBe('https://app.example.com/sso/start');
            expect(start.searchParams.get('returnUrl')).toBe(config.sites[0]?.launcher?.launchUrl);
            expect(start.searchParams.get('scope')).toBe('*');
            expect((await browser.get(authorizeUrl())).statusCode).toBe(302);
            expect(emails).toHaveLength(1);
            expect(
                (await browser.get(authorizeUrl('app', { redirectUri: issuer + '/sso/apps' })))
                    .statusCode,
            ).toBe(400);
        },
    );

    it('opens each launcher application in a new tab without an opener or referrer', async () => {
        configureLauncher();
        await confirm(await sendLauncher());
        const page = await browser.get('/sso/apps');
        const links = [...page.body.matchAll(/<a class="application"[^>]*>/gu)].map(
            ([link]) => link,
        );
        expect(links).toHaveLength(2);
        for (const link of links) {
            expect(link).toContain('target="_blank"');
            expect(link).toContain('rel="noopener noreferrer"');
            expect(link).toContain('(opens in a new tab)');
        }
        expect(page.body).toContain('Each application opens in a new tab.');
    });

    it('filters scoped grants, ignores unlisted sites, and reflects revoked access immediately', async () => {
        configureLauncher();
        await confirm(await sendLauncher('reader@example.com'));
        let page = await browser.get('/sso/apps');
        expect(page.body).toContain('Private photos');
        expect(page.body).not.toContain('Documents &amp; reports');
        config.sites[1]?.accessRules.delete('reader@example.com');
        page = await browser.get('/sso/apps');
        expect(page.body).toContain('No applications available');
        expect(page.body).not.toContain('Private photos');
        const site = config.sites[0];
        if (!site) {
            throw new Error('Missing site');
        }
        site.accessRules.set('reader@example.com', new Set(['*']));
        expect((await browser.get('/sso/apps')).body).toContain('Documents &amp; reports');
        site.launcher = undefined;
        expect((await browser.get('/sso/apps')).body).not.toContain('Documents &amp; reports');
    });

    it('reads live grants after awaiting the central session', async () => {
        configureLauncher();
        await confirm(await sendLauncher());
        const original = state.browserSsoStore.getSession.bind(state.browserSsoStore);
        vi.spyOn(state.browserSsoStore, 'getSession').mockImplementationOnce(
            async (handle, now) => {
                const session = await original(handle, now);
                for (const site of config.sites) {
                    site.accessRules.delete('owner@example.com');
                }
                return session;
            },
        );
        expect((await browser.get('/sso/apps')).body).toContain('No applications available');
    });

    it('uses the explicit destination origin among several registrations and escapes display names', async () => {
        configureLauncher();
        const site = config.sites[0];
        if (!site || !site.launcher || !site.sso) {
            throw new Error('Missing launcher');
        }
        site.origins.add('https://alternate.test');
        site.sso.push({
            redirectUri: 'https://alternate.test/sso/callback',
            startUri: 'https://alternate.test/sso/start',
            signedOutUri: 'https://alternate.test/signed-out',
        });
        site.launcher = {
            name: '<img src=x onerror=alert(1)>',
            launchUrl: 'https://alternate.test/reports',
            scope: '*',
        };
        await confirm(await sendLauncher());
        const page = await browser.get('/sso/apps');
        expect(page.body).toContain('https://alternate.test/sso/start?');
        expect(page.body).not.toContain('href="https://app.example.com/sso/start');
        expect(page.body).toContain('&lt;img src=x onerror=alert(1)&gt;');
        expect(page.body).not.toContain('<img src=x');
    });

    it('keeps account changes explicit and rotates the central session only after confirmation', async () => {
        configureLauncher();
        const appToken = await accessToken(await exchange(await confirm(await send())));
        const previous = central();
        const sent = await sendLauncher('other@example.com');
        expect(central()).toBe(previous);
        expect((await browser.get('/sso/apps')).body).toContain('owner@example.com');
        await confirm(sent);
        expect(central()).not.toBe(previous);
        expect(await state.browserSsoStore.getSession(previous ?? '', Date.now())).toBeNull();
        expect((await browser.get('/sso/apps')).body).toContain('other@example.com');
        expect(
            await verifyAccessToken(appToken, config.jwtSecret, {
                expectedIssuer: issuer,
                expectedAudience: 'https://app.example.com',
            }),
        ).toMatchObject({ email: 'owner@example.com' });
    });

    it('requires CSRF for launcher sign-in and central logout, then returns to the signed-out launcher', async () => {
        configureLauncher();
        const entry = await browser.get('/sso/apps');
        expect(
            (
                await browser.post(
                    '/sso/apps/signin',
                    { csrfToken: hidden(entry.body, 'csrfToken') },
                    'https://evil.test',
                )
            ).statusCode,
        ).toBe(403);
        expect((await browser.post('/sso/apps/signin', {})).statusCode).toBe(403);
        await confirm(await sendLauncher());
        const handle = central();
        const returnUri = issuer + '/sso/apps';
        const confirmation = await browser.get(
            `/sso/signout?${new URLSearchParams({ returnUri })}`,
        );
        expect(confirmation.statusCode).toBe(200);
        expect(central()).toBe(handle);
        const fields = { csrfToken: hidden(confirmation.body, 'csrfToken'), returnUri };
        expect((await browser.post('/sso/signout', fields, 'https://evil.test')).statusCode).toBe(
            403,
        );
        expect(
            (
                await browser.post('/sso/signout', {
                    ...fields,
                    returnUri: issuer + '/sso/apps?next=https://evil.test',
                })
            ).statusCode,
        ).toBe(400);
        const completed = await browser.post('/sso/signout', fields);
        expect(completed.statusCode).toBe(303);
        expect(completed.headers.location).toBe(returnUri);
        expect(central()).toBeUndefined();
        const page = await browser.get('/sso/apps');
        expect(page.body).toContain('Sign in with your email');
        expect(page.body).not.toContain('owner@example.com');
        expect(await state.browserSsoStore.getSession(handle ?? '', Date.now())).toBeNull();
    });

    it('keeps the previous central identity when launcher access disappears during session creation', async () => {
        configureLauncher();
        await confirm(await sendLauncher());
        const previous = central();
        const sent = await sendLauncher('other@example.com');
        const create = state.browserSsoStore.createSession.bind(state.browserSsoStore);
        let rejectedHandle: string | undefined;
        vi.spyOn(state.browserSsoStore, 'createSession').mockImplementationOnce(async (input) => {
            const created = await create(input);
            rejectedHandle = created.handle;
            for (const site of config.sites) {
                site.accessRules.delete('other@example.com');
            }
            return created;
        });
        expect((await confirm(sent)).statusCode).toBe(403);
        expect(central()).toBe(previous);
        expect((await state.browserSsoStore.getSession(previous ?? '', Date.now()))?.email).toBe(
            'owner@example.com',
        );
        expect(await state.browserSsoStore.getSession(rejectedHandle ?? '', Date.now())).toBeNull();
    });

    it('rejects revoked launcher grants at confirmation and does not send emails to unlisted accounts', async () => {
        configureLauncher();
        const sent = await sendLauncher();
        for (const site of config.sites) {
            site.accessRules.delete('owner@example.com');
        }
        expect((await confirm(sent)).statusCode).toBe(403);
        expect(central()).toBeUndefined();
        const form = await startLauncher();
        const denied = await browser.post('/sso/signin', {
            csrfToken: hidden(form.body, 'csrfToken'),
            requestId: hidden(form.body, 'requestId'),
            email: 'unknown@example.com',
        });
        expect(denied.statusCode).toBe(200);
        expect(emails).toHaveLength(1);
    });

    it('clears an expired central cookie and leaves an unconfigured launcher disabled', async () => {
        expect((await browser.get('/sso/apps')).statusCode).toBe(409);
        configureLauncher();
        await confirm(await sendLauncher());
        const session = await state.browserSsoStore.getSession(central() ?? '', Date.now());
        if (!session) {
            throw new Error('Missing session');
        }
        vi.spyOn(Date, 'now').mockReturnValue(session.expiresAt);
        const expired = await browser.get('/sso/apps');
        expect(expired.body).not.toContain('owner@example.com');
        expect(central()).toBeUndefined();
    });

    it('classifies malformed JSON as a bad request and uses no-store protocol responses', async () => {
        const response = await app.inject({
            method: 'POST',
            url: '/sso/exchange',
            payload: '{broken',
            headers: { 'content-type': 'application/json' },
        });
        expect(response.statusCode).toBe(400);
        expect(response.json()).toMatchObject({ error: 'invalid_request' });
        expect(response.headers['cache-control']).toBe('no-store');
        expect(response.headers['referrer-policy']).toBe('no-referrer');
    });
});
