// SPDX-License-Identifier: GPL-3.0-or-later
import { createHash, randomUUID } from 'node:crypto';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { FastifyInstance, LightMyRequestResponse } from 'fastify';
import { z } from 'zod';
import { beforeEach, afterEach, describe, expect, it, vi } from 'vitest';
import { buildApp } from './app.js';
import { parseMagicSsoConfigToml, type AppConfig } from './config.js';
import { createSecurityState, type SharedSecurityState } from './securityState.js';
import { createBrowserSsoOpaqueValue } from './browserSsoStore.js';
import { verifyAccessToken } from './auth.js';
import {
    createBrowserSsoBootstrapReceipt,
    hashBrowserSsoToken,
} from '@magic-link-sso/config-core/runtime';
import type { VerificationEmailInput } from './email.js';
const issuer = 'https://sso.example.com';
const origin = 'https://app.example.com';
const redirectUri = origin + '/sso/callback';
const verifier = 'dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk';
const challenge = createHash('sha256').update(verifier).digest('base64url');
const successSchema = z.object({
    accessToken: z.string(),
    browserSso: z
        .union([z.object({ bootstrapTicket: z.string() }), z.object({ error: z.string() })])
        .optional(),
});
interface Prepared {
    state: string;
    context: { requestId: string; codeVerifier: string; redirectUri: string };
}
class Browser {
    readonly cookies: Map<string, string> = new Map();
    constructor(private readonly app: FastifyInstance) {}
    private remember(response: LightMyRequestResponse): LightMyRequestResponse {
        for (const cookie of response.cookies) {
            if (!cookie.value || cookie.maxAge === 0) {
                this.cookies.delete(cookie.name);
            } else {
                this.cookies.set(cookie.name, cookie.value);
            }
        }
        return response;
    }
    async get(url: string): Promise<LightMyRequestResponse> {
        return this.remember(
            await this.app.inject({
                url,
                cookies: Object.fromEntries(this.cookies),
                headers: { accept: 'text/html' },
            }),
        );
    }
    async post(
        url: string,
        payload: Record<string, string>,
        source = issuer,
    ): Promise<LightMyRequestResponse> {
        return this.remember(
            await this.app.inject({
                method: 'POST',
                url,
                cookies: Object.fromEntries(this.cookies),
                headers: {
                    origin: source,
                    accept: 'text/html',
                    'content-type': 'application/x-www-form-urlencoded',
                },
                payload: new URLSearchParams(payload).toString(),
            }),
        );
    }
}
function hidden(body: string, name: string): string {
    const value = body.match(new RegExp(`name="${name}" value="([^"]+)"`, 'u'))?.[1];
    if (!value) {
        throw new Error('Missing confirmation field ' + name);
    }
    return value.replaceAll('&amp;', '&');
}
describe(`app-owned bootstrap issuer (${process.env.MAGICSSO_TEST_REDIS_URL ? 'Redis' : 'file'})`, () => {
    let directory: string;
    let config: AppConfig;
    let app: FastifyInstance;
    let state: SharedSecurityState;
    let browser: Browser;
    let emails: VerificationEmailInput[];
    beforeEach(async () => {
        directory = await mkdtemp(join(tmpdir(), 'magic-sso-bootstrap-http-'));
        const source = await readFile(
            new URL('../../packages/config-core/src/browser-sso.fixture.toml', import.meta.url),
            'utf8',
        );
        config = parseMagicSsoConfigToml(
            source.replace('enabled = false', 'enabled = true\nbootstrapEnabled = true'),
            'bootstrap-fixture',
        );
        config.verifyTokenStoreDir = join(directory, 'tokens');
        config.signInEmailRateLimitStoreDir = join(directory, 'limits');
        config.signInPageRateLimitMax = 200;
        config.signInRateLimitMax = 200;
        config.verifyRateLimitMax = 200;
        config.signInEmailRateLimitMax = 200;
        config.otp = {
            ...config.otp,
            enabled: true,
            secret: 'synthetic-bootstrap-otp-secret-0123456789',
        };
        config.sites[0]?.accessRules.set('other@example.com', new Set(['*']));
        if (process.env.MAGICSSO_TEST_REDIS_URL) {
            config.securityState = {
                adapter: 'redis',
                redisUrl: process.env.MAGICSSO_TEST_REDIS_URL,
                keyPrefix: 'magic-sso-bootstrap-http-' + randomUUID(),
            };
        }
        state = await createSecurityState(config);
        emails = [];
        app = await buildApp({
            config,
            securityState: state,
            logger: false,
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
        await rm(directory, { recursive: true, force: true });
    });
    async function api(
        url: string,
        payload: Record<string, unknown>,
    ): Promise<LightMyRequestResponse> {
        return app.inject({
            method: 'POST',
            url,
            headers: { accept: 'application/json', 'content-type': 'application/json' },
            payload,
        });
    }
    async function prepare(target = browser, prompt?: 'login'): Promise<Prepared> {
        const nonce = createBrowserSsoOpaqueValue();
        const response = await target.get(
            '/sso/authorize?' +
                new URLSearchParams({
                    redirectUri,
                    state: nonce,
                    codeChallenge: challenge,
                    codeChallengeMethod: 'S256',
                    loginUi: 'app-owned',
                    ...(prompt ? { prompt } : {}),
                }),
        );
        expect(response.statusCode).toBe(302);
        const destination = new URL(response.headers.location ?? '');
        expect(destination.origin + destination.pathname).toBe(origin + '/sso/start');
        expect(destination.searchParams.get('state')).toBe(nonce);
        const requestId = z.string().parse(destination.searchParams.get('requestId'));
        return { state: nonce, context: { requestId, codeVerifier: verifier, redirectUri } };
    }
    async function signin(
        prepared: Prepared,
        email = 'owner@example.com',
    ): Promise<LightMyRequestResponse> {
        const response = await api('/signin', {
            email,
            returnUrl: origin + '/reports?tag=one&tag=two',
            verifyUrl: origin + '/verify-email',
            browserSso: prepared.context,
        });
        expect(response.statusCode).toBe(200);
        return response;
    }
    async function verified(
        prepared: Prepared,
        method: 'link' | 'otp' = 'link',
    ): Promise<{ accessToken: string; ticket: string; response: LightMyRequestResponse }> {
        const sent = await signin(prepared);
        const email = emails.at(-1);
        if (!email) {
            throw new Error('No email sent');
        }
        const response =
            method === 'link'
                ? await api('/verify-email', { token: email.token, browserSso: prepared.context })
                : await api('/verify-email/otp', {
                      challengeId: z.object({ otpChallengeId: z.string() }).parse(sent.json())
                          .otpChallengeId,
                      code: email.otpCode,
                      browserSso: prepared.context,
                  });
        expect(response.statusCode).toBe(200);
        const body = successSchema.parse(response.json());
        if (!body.browserSso || !('bootstrapTicket' in body.browserSso)) {
            throw new Error('Missing bootstrap ticket: ' + response.body);
        }
        return { accessToken: body.accessToken, ticket: body.browserSso.bootstrapTicket, response };
    }
    function redemption(prepared: Prepared, ticket: string): string {
        return (
            '/sso/bootstrap/redeem?' +
            new URLSearchParams({ ticket, state: prepared.state, redirectUri })
        );
    }
    it('advertises bootstrap only for the explicit issuer policy', async () => {
        expect((await app.inject('/sso/capabilities')).json()).toMatchObject({
            browserSso: { appOwnedBootstrapVersion: 1 },
        });
        if (!config.browserSso) {
            throw new Error('Missing policy');
        }
        config.browserSso.bootstrapEnabled = false;
        expect((await app.inject('/sso/capabilities')).json().browserSso).not.toHaveProperty(
            'appOwnedBootstrapVersion',
        );
        expect((await api('/sso/bootstrap/inspect', {})).statusCode).toBe(409);
    });
    it('inspects only a matching backend PKCE transaction without exposing browser binding', async () => {
        const prepared = await prepare();
        const response = await api('/sso/bootstrap/inspect', prepared.context);
        expect(response.statusCode).toBe(200);
        expect(response.json()).toMatchObject({
            state: prepared.state,
            requestId: prepared.context.requestId,
            scope: '*',
        });
        expect(response.body).not.toContain('bindingHash');
        expect(
            (
                await api('/sso/bootstrap/inspect', {
                    ...prepared.context,
                    codeVerifier: 'z'.repeat(43),
                })
            ).statusCode,
        ).toBe(400);
        expect(
            (
                await app.inject({
                    method: 'POST',
                    url: '/sso/bootstrap/inspect',
                    headers: { origin, 'content-type': 'application/json' },
                    payload: prepared.context,
                })
            ).statusCode,
        ).toBe(400);
        expect((await api('/sso/bootstrap/inspect', prepared.context)).statusCode).toBe(200);
    });
    it.each(['link', 'otp'] as const)(
        'establishes central SSO after local %s verification without a second JWT exchange',
        async (method) => {
            // Literal method preserves the verification helper union.
            const prepared = await prepare();
            const local = await verified(prepared, method);
            expect(
                local.response.cookies.some((cookie) => cookie.name === '__Host-magic-sso-browser'),
            ).toBe(false);
            const auth = await verifyAccessToken(local.accessToken, config.jwtSecret, {
                expectedAudience: origin,
                expectedIssuer: issuer,
            });
            expect(auth?.email).toBe('owner@example.com');
            expect((auth?.exp ?? Infinity) - (auth?.iat ?? 0)).toBeLessThanOrEqual(
                config.browserSso?.sessionLifetimeSeconds ?? 0,
            );
            const done = await browser.get(redemption(prepared, local.ticket));
            expect(done.statusCode).toBe(302);
            const callback = new URL(done.headers.location ?? '');
            expect(callback.origin + callback.pathname).toBe(redirectUri);
            expect(callback.searchParams.get('browserSso')).toBe('complete');
            expect(callback.searchParams.get('receipt')).toBe(
                await createBrowserSsoBootstrapReceipt(config.jwtSecret, {
                    issuer,
                    audience: origin,
                    redirectUri,
                    state: prepared.state,
                    bootstrapTicket: local.ticket,
                    accessTokenHash: await hashBrowserSsoToken(local.accessToken),
                }),
            );
            const handle = browser.cookies.get('__Host-magic-sso-browser');
            expect(handle).toBeTruthy();
            expect((await state.browserSsoStore.getSession(handle ?? '', Date.now()))?.email).toBe(
                'owner@example.com',
            );
            expect((await browser.get(redemption(prepared, local.ticket))).statusCode).toBe(400);
            expect(
                (
                    await api('/verify-email', {
                        token: emails[0]?.token,
                        browserSso: prepared.context,
                    })
                ).statusCode,
            ).toBe(400);
            expect(emails).toHaveLength(1);
        },
    );
    it('uses normal authorization codes when the central session already exists', async () => {
        const prepared = await prepare();
        const local = await verified(prepared);
        await browser.get(redemption(prepared, local.ticket));
        const result = await browser.get(
            '/sso/authorize?' +
                new URLSearchParams({
                    redirectUri,
                    state: createBrowserSsoOpaqueValue(),
                    codeChallenge: challenge,
                    codeChallengeMethod: 'S256',
                    loginUi: 'app-owned',
                }),
        );
        const callback = new URL(result.headers.location ?? '');
        expect(callback.pathname).toBe('/sso/callback');
        expect(callback.searchParams.has('code')).toBe(true);
        expect(emails).toHaveLength(1);
    });
    it('requires explicit CSRF-protected confirmation in another browser and starts fresh app state there', async () => {
        const prepared = await prepare();
        const local = await verified(prepared);
        const other = new Browser(app);
        const page = await other.get(redemption(prepared, local.ticket));
        expect(page.statusCode).toBe(200);
        expect(page.body).toContain('owner@example.com');
        expect(other.cookies.has('__Host-magic-sso-browser')).toBe(false);
        const fields = {
            ticket: local.ticket,
            state: prepared.state,
            redirectUri,
            csrfToken: hidden(page.body, 'csrfToken'),
        };
        expect(
            (await other.post('/sso/bootstrap/redeem', { ...fields, csrfToken: 'z'.repeat(43) }))
                .statusCode,
        ).toBe(403);
        expect(
            (await other.post('/sso/bootstrap/redeem', fields, 'https://evil.example')).statusCode,
        ).toBe(403);
        expect(
            await state.browserSsoStore.getBootstrapTicket(local.ticket, Date.now()),
        ).not.toBeNull();
        const result = await other.post('/sso/bootstrap/redeem', fields);
        expect(result.statusCode).toBe(200);
        expect(result.body).toContain('Continue to application');
        expect(result.body).toContain(origin + '/sso/start');
        expect(result.headers.location).toBeUndefined();
        expect(other.cookies.has('__Host-magic-sso-browser')).toBe(true);
        expect(browser.cookies.has('__Host-magic-sso-browser')).toBe(false);
    });
    it('rejects wrong callback and state without consuming a ticket', async () => {
        const prepared = await prepare();
        const local = await verified(prepared);
        for (const override of [
            { state: 'z'.repeat(43) },
            { redirectUri: origin + '/different-callback' },
        ]) {
            expect(
                (
                    await browser.get(
                        '/sso/bootstrap/redeem?' +
                            new URLSearchParams({
                                ticket: local.ticket,
                                state: prepared.state,
                                redirectUri,
                                ...override,
                            }),
                    )
                ).statusCode,
            ).toBe(400);
            expect(
                await state.browserSsoStore.getBootstrapTicket(local.ticket, Date.now()),
            ).not.toBeNull();
        }
        expect((await browser.get(redemption(prepared, local.ticket))).statusCode).toBe(302);
    });
    it('rejects iframe/prefetch authorization and ticket redemption before mutating state', async () => {
        const prepared = await prepare();
        const local = await verified(prepared);
        const cookie = Object.fromEntries(browser.cookies);
        const rejected = await app.inject({
            url: redemption(prepared, local.ticket),
            cookies: cookie,
            headers: { 'sec-fetch-mode': 'navigate', 'sec-fetch-dest': 'iframe' },
        });
        expect(rejected.statusCode).toBe(403);
        expect(
            await state.browserSsoStore.getBootstrapTicket(local.ticket, Date.now()),
        ).not.toBeNull();
        const requestSpy = vi.spyOn(state.browserSsoStore, 'createRequest');
        const prefetch = await app.inject({
            url:
                '/sso/authorize?' +
                new URLSearchParams({
                    redirectUri,
                    state: createBrowserSsoOpaqueValue(),
                    codeChallenge: challenge,
                    codeChallengeMethod: 'S256',
                }),
            headers: { purpose: 'prefetch' },
        });
        expect(prefetch.statusCode).toBe(400);
        expect(requestSpy).not.toHaveBeenCalled();
        expect(prefetch.cookies).toEqual([]);
    });
    it('rotates bootstrap grants on resend while preserving local verification responses', async () => {
        const prepared = await prepare();
        await signin(prepared);
        const older = emails[0]?.token;
        await signin(prepared);
        const old = successSchema.parse(
            (await api('/verify-email', { token: older, browserSso: prepared.context })).json(),
        );
        expect(old.browserSso).toEqual({ error: 'request_expired' });
        expect(old.accessToken).toBeTruthy();
        const current = successSchema.parse(
            (
                await api('/verify-email', {
                    token: emails[1]?.token,
                    browserSso: prepared.context,
                })
            ).json(),
        );
        expect(current.browserSso).toHaveProperty('bootstrapTicket');
    });
    it('retains a valid local JWT after bootstrap persistence fails and never retries the consumed grant', async () => {
        const prepared = await prepare();
        await signin(prepared);
        vi.spyOn(state.browserSsoStore, 'issueBootstrapTicket').mockRejectedValue(
            new Error('sensitive-proof-value'),
        );
        const response = await api('/verify-email', {
            token: emails[0]?.token,
            browserSso: prepared.context,
        });
        expect(response.statusCode).toBe(200);
        expect(response.body).not.toContain('sensitive-proof-value');
        const local = successSchema.parse(response.json());
        expect(local.browserSso).toEqual({ error: 'temporarily_unavailable' });
        expect(
            await verifyAccessToken(local.accessToken, config.jwtSecret, {
                expectedIssuer: issuer,
                expectedAudience: origin,
            }),
        ).not.toBeNull();
        expect(
            (await api('/verify-email', { token: emails[0]?.token, browserSso: prepared.context }))
                .statusCode,
        ).toBe(400);
    });
    it('checks current grants around redemption and leaves the local JWT valid', async () => {
        const prepared = await prepare();
        const local = await verified(prepared);
        const original = state.browserSsoStore.redeemBootstrapTicket.bind(state.browserSsoStore);
        vi.spyOn(state.browserSsoStore, 'redeemBootstrapTicket').mockImplementation(
            async (input) => {
                const result = await original(input);
                config.sites[0]?.accessRules.delete('owner@example.com');
                return result;
            },
        );
        const response = await browser.get(redemption(prepared, local.ticket));
        expect(response.statusCode).toBe(403);
        expect(browser.cookies.has('__Host-magic-sso-browser')).toBe(false);
        expect(
            await verifyAccessToken(local.accessToken, config.jwtSecret, {
                expectedIssuer: issuer,
                expectedAudience: origin,
            }),
        ).not.toBeNull();
    });
    it('central logout cancels a previously issued bootstrap ticket', async () => {
        const prepared = await prepare();
        const local = await verified(prepared);
        const page = await browser.get('/sso/signout');
        expect(
            (await browser.post('/sso/signout', { csrfToken: hidden(page.body, 'csrfToken') }))
                .statusCode,
        ).toBe(200);
        const response = await browser.get(redemption(prepared, local.ticket));
        expect(response.statusCode).toBe(400);
        expect(browser.cookies.has('__Host-magic-sso-browser')).toBe(false);
    });
    it('expires tickets without clearing an independently valid local JWT', async () => {
        const prepared = await prepare();
        const local = await verified(prepared);
        vi.spyOn(Date, 'now').mockReturnValue(Date.now() + 61_000);
        const response = await browser.get(redemption(prepared, local.ticket));
        expect(response.statusCode).toBe(400);
        expect(response.body).toContain('Shared browser sign-in was not completed');
        expect(
            await verifyAccessToken(local.accessToken, config.jwtSecret, {
                expectedIssuer: issuer,
                expectedAudience: origin,
            }),
        ).not.toBeNull();
    });
    it('requires explicit confirmation before replacing a different central account', async () => {
        const first = await prepare();
        const original = await verified(first);
        await browser.get(redemption(first, original.ticket));
        const previous = browser.cookies.get('__Host-magic-sso-browser') ?? '';
        const next = await prepare(browser, 'login');
        await signin(next, 'other@example.com');
        const body = successSchema.parse(
            (
                await api('/verify-email', {
                    token: emails.at(-1)?.token,
                    browserSso: next.context,
                })
            ).json(),
        );
        if (!body.browserSso || !('bootstrapTicket' in body.browserSso)) {
            throw new Error('No ticket');
        }
        const page = await browser.get(redemption(next, body.browserSso.bootstrapTicket));
        expect(page.statusCode).toBe(200);
        expect(page.body).toContain('other@example.com');
        expect(browser.cookies.get('__Host-magic-sso-browser')).toBe(previous);
        const done = await browser.post('/sso/bootstrap/redeem', {
            ticket: body.browserSso.bootstrapTicket,
            state: next.state,
            redirectUri,
            csrfToken: hidden(page.body, 'csrfToken'),
        });
        expect(done.statusCode).toBe(303);
        expect(await state.browserSsoStore.getSession(previous, Date.now())).toBeNull();
        expect(
            (
                await verifyAccessToken(original.accessToken, config.jwtSecret, {
                    expectedIssuer: issuer,
                    expectedAudience: origin,
                })
            )?.email,
        ).toBe('owner@example.com');
    });
    it('denies a grant revoked while local verification awaits ticket storage', async () => {
        const prepared = await prepare();
        await signin(prepared);
        const original = state.browserSsoStore.issueBootstrapTicket.bind(state.browserSsoStore);
        vi.spyOn(state.browserSsoStore, 'issueBootstrapTicket').mockImplementation(
            async (input) => {
                const result = await original(input);
                config.sites[0]?.accessRules.delete('owner@example.com');
                return result;
            },
        );
        const response = await api('/verify-email', {
            token: emails[0]?.token,
            browserSso: prepared.context,
        });
        expect(response.statusCode).toBe(403);
        expect(response.json()).not.toHaveProperty('accessToken');
    });
    it('preserves the existing JSON response when bootstrap is disabled', async () => {
        if (!config.browserSso) {
            throw new Error('No policy');
        }
        config.browserSso.bootstrapEnabled = false;
        expect(
            (
                await api('/signin', {
                    email: 'owner@example.com',
                    returnUrl: origin + '/reports',
                    verifyUrl: origin + '/verify-email',
                    browserSso: { ignored: true },
                })
            ).statusCode,
        ).toBe(200);
        const response = await api('/verify-email', {
            token: emails[0]?.token,
            browserSso: { ignored: true },
        });
        expect(response.statusCode).toBe(200);
        expect(Object.keys(response.json())).toEqual(['accessToken']);
    });
});
