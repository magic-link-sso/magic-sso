// SPDX-License-Identifier: MIT
import { SignJWT } from 'jose';
import { expect, it, vi } from 'vitest';
import { createBrowserSsoHttpHandler, type BrowserSsoHttpOptions } from './browser-sso-http.js';
import {
    createBrowserSsoBootstrapReceipt,
    hashBrowserSsoToken,
} from './browser-sso-bootstrap-receipt.js';
const options: BrowserSsoHttpOptions = {
    mode: 'required',
    loginUi: 'app-owned',
    issuer: 'https://sso.example.com',
    audience: 'https://app.example.com',
    redirectUri: 'https://app.example.com/sso/callback',
    secret: 'fixture-app-owned-http-secret-0123456789abcdef',
    previewSecret: 'synthetic-preview-secret',
    cookieName: 'app-session',
};
const requestId = 'R'.repeat(43),
    ticket = 'T'.repeat(43);
async function setup(): Promise<{
    handle: (request: Request) => Promise<Response>;
    jar: Map<string, string>;
    get: (path: string) => Promise<Response>;
    post: (body: Record<string, string>, origin?: string) => Promise<Response>;
    state: string;
    jwt: string;
    fetcher: ReturnType<typeof vi.fn<typeof fetch>>;
}> {
    let state = '';
    const jwt = await new SignJWT({
        email: 'user@example.com',
        siteId: 'app',
        scope: '',
        jti: crypto.randomUUID(),
    })
        .setProtectedHeader({ alg: 'HS256' })
        .setIssuedAt()
        .setExpirationTime('1h')
        .setIssuer(options.issuer)
        .setAudience(options.audience)
        .sign(new TextEncoder().encode(options.secret));
    const fetcher = vi.fn<typeof fetch>(async (url, init) => {
        switch (new URL(String(url)).pathname) {
            case '/sso/capabilities':
                return Response.json({
                    browserSso: {
                        version: 1,
                        enabled: true,
                        loginUi: 'hosted',
                        codeChallengeMethods: ['S256'],
                        requestLifetimeSeconds: 900,
                        codeLifetimeSeconds: 60,
                        transactionLifetimeSeconds: 990,
                        appOwnedBootstrapVersion: 1,
                    },
                });
            case '/sso/bootstrap/inspect':
                return Response.json({
                    requestId,
                    state,
                    scope: '',
                    expiresAt: Date.now() + 900_000,
                });
            case '/signin':
                return Response.json({
                    success: true,
                    otpChallengeId: 'challenge',
                    otpLength: 6,
                    otpExpiresInSeconds: 300,
                });
            case '/verify-email':
                return init?.method === 'GET'
                    ? Response.json({ email: 'user@example.com' })
                    : Response.json({ accessToken: jwt, browserSso: { bootstrapTicket: ticket } });
            case '/verify-email/otp':
                return Response.json({ accessToken: jwt, browserSso: { bootstrapTicket: ticket } });
            default:
                throw new Error('Unexpected backend request');
        }
    });
    const handle = createBrowserSsoHttpHandler({ ...options, fetcher }),
        jar = new Map<string, string>();
    function remember(response: Response): Response {
        for (const cookie of response.headers.getSetCookie()) {
            const match = cookie.match(/^([^=]+)=([^;]*)/u);
            if (!match) {
                continue;
            }
            if (cookie.includes('Max-Age=0')) {
                jar.delete(match[1]);
            } else {
                jar.set(match[1], decodeURIComponent(match[2]));
            }
        }
        return response;
    }
    const get = async (path: string): Promise<Response> =>
        remember(
            await handle(
                new Request(new URL(path, options.audience), {
                    headers: { cookie: [...jar].map(([k, v]) => `${k}=${v}`).join('; ') },
                }),
            ),
        );
    const post = async (
        body: Record<string, string>,
        origin = options.audience,
    ): Promise<Response> =>
        remember(
            await handle(
                new Request(new URL('/sso/start', options.audience), {
                    method: 'POST',
                    headers: {
                        cookie: [...jar].map(([k, v]) => `${k}=${v}`).join('; '),
                        origin,
                        'content-type': 'application/x-www-form-urlencoded',
                    },
                    body: new URLSearchParams(body),
                }),
            ),
        );
    const start = await get('/sso/start?returnUrl=%2Fprotected%3Ftag%3Da%26tag%3Db');
    state = new URL(start.headers.get('location') ?? '').searchParams.get('state') ?? '';
    const prepared = await get(
        '/sso/start?' + new URLSearchParams({ state, requestId, ssoPrepared: '1' }),
    );
    expect(await prepared.text()).toContain('Send magic link');
    expect(prepared.headers.get('content-security-policy')).toContain("script-src 'none'");
    return { handle, jar, get, post, state, jwt, fetcher };
}
function hidden(html: string, name: string): string {
    return html.match(new RegExp(`name="${name}" value="([^"]*)"`, 'u'))?.[1] ?? '';
}
for (const method of ['link', 'otp']) {
    it(`completes an app-owned ${method} with the local JWT set before the issuer visit and no callback auth mutation`, async () => {
        const f = await setup();
        const sent = await f.post({
            action: 'send',
            state: f.state,
            email: 'user@example.com',
            returnUrl: '/protected?tag=a&tag=b',
            scope: '',
        });
        expect(await sent.text()).toContain('Check your email');
        const signin = f.fetcher.mock.calls.find(
            ([url]) => new URL(String(url)).pathname === '/signin',
        );
        const body: { browserSso: { requestId: string; codeVerifier: string }; verifyUrl: string } =
            JSON.parse(String(signin?.[1]?.body));
        expect(body.browserSso.requestId).toBe(requestId);
        expect(body.browserSso.codeVerifier).toHaveLength(43);
        let verified: Response;
        if (method === 'otp') {
            verified = await f.post({
                action: 'otp',
                state: f.state,
                challengeId: 'challenge',
                code: '123456',
            });
        } else {
            const confirm = await f.get(body.verifyUrl + '&token=synthetic-email-proof');
            const html = await confirm.text();
            expect(html).toContain('user@example.com');
            expect(f.jar.has(options.cookieName)).toBe(false);
            verified = await f.post({
                action: 'verify',
                state: f.state,
                token: 'synthetic-email-proof',
                csrfToken: hidden(html, 'csrfToken'),
            });
        }
        expect(verified.status).toBe(303);
        expect(new URL(verified.headers.get('location') ?? '').pathname).toBe(
            '/sso/bootstrap/redeem',
        );
        expect(f.jar.get(options.cookieName)).toBe(f.jwt);
        const receipt = await createBrowserSsoBootstrapReceipt(options.secret, {
            ...options,
            state: f.state,
            bootstrapTicket: ticket,
            accessTokenHash: await hashBrowserSsoToken(f.jwt),
        });
        const finish = await f.get(
            '/sso/callback?' +
                new URLSearchParams({ state: f.state, browserSso: 'complete', receipt }),
        );
        expect(finish.status).toBe(303);
        expect(finish.headers.get('location')).toBe(options.audience + '/protected?tag=a&tag=b');
        expect(
            finish.headers
                .getSetCookie()
                .some((cookie) => cookie.startsWith(options.cookieName + '=')),
        ).toBe(false);
        expect(f.jar.size).toBe(1);
        expect(f.jar.get(options.cookieName)).toBe(f.jwt);
        expect(
            f.fetcher.mock.calls.some(([url]) => new URL(String(url)).pathname === '/sso/exchange'),
        ).toBe(false);
    });
}
it('rejects cross-origin mutations and prefetch without touching the issuer or existing app cookie', async () => {
    const f = await setup();
    f.jar.set(options.cookieName, f.jwt);
    const calls = f.fetcher.mock.calls.length;
    expect(
        (
            await f.post(
                { action: 'otp', state: f.state, challengeId: 'challenge', code: '123456' },
                'https://attacker.example',
            )
        ).status,
    ).toBe(400);
    expect(f.fetcher.mock.calls).toHaveLength(calls);
    const prefetch = await f.handle(
        new Request(options.audience + '/sso/start?ssoPrepared=1', {
            headers: { purpose: 'prefetch' },
        }),
    );
    expect(prefetch.headers.getSetCookie()).toHaveLength(0);
    expect(f.fetcher.mock.calls).toHaveLength(calls);
    expect(f.jar.get(options.cookieName)).toBe(f.jwt);
});
it('retains the local JWT when the bootstrap result is lost or the finish has no local session', async () => {
    const f = await setup();
    f.fetcher.mockImplementationOnce(async () =>
        Response.json({ accessToken: f.jwt, browserSso: { error: 'temporarily_unavailable' } }),
    );
    const result = await f.post({
        action: 'otp',
        state: f.state,
        challengeId: 'challenge',
        code: '123456',
    });
    expect(await result.text()).toContain('Shared sign-in was not completed');
    expect(f.jar.get(options.cookieName)).toBe(f.jwt);
    const second = await setup();
    await second.post({
        action: 'otp',
        state: second.state,
        challengeId: 'challenge',
        code: '123456',
    });
    second.jar.delete(options.cookieName);
    const finish = await second.get(
        '/sso/callback?' +
            new URLSearchParams({
                state: second.state,
                browserSso: 'complete',
                receipt: 'Z'.repeat(43),
            }),
    );
    expect(finish.status).toBe(200);
    expect(await finish.text()).toContain('Shared sign-in was not completed');
    expect(
        finish.headers
            .getSetCookie()
            .every((cookie) => !cookie.startsWith(options.cookieName + '=')),
    ).toBe(true);
});
it('requires a cookie path covering the finish callback', () => {
    expect(() => createBrowserSsoHttpHandler({ ...options, cookiePath: '/private' })).toThrow(
        'cookie path must cover',
    );
});

it('allows explicit local email confirmation in another browser while reporting that shared setup did not complete', async () => {
    const f = await setup();
    f.jar.clear();
    const confirm = await f.get(
        '/sso/start?' +
            new URLSearchParams({ action: 'verify', state: f.state, token: 'synthetic-proof' }),
    );
    const html = await confirm.text();
    expect(html).toContain('user@example.com');
    const result = await f.post({
        action: 'verify',
        state: f.state,
        token: 'synthetic-proof',
        csrfToken: hidden(html, 'csrfToken'),
    });
    expect(await result.text()).toContain('Shared sign-in was not completed');
    expect(f.jar.get(options.cookieName)).toBe(f.jwt);
    const verification = f.fetcher.mock.calls.filter(
        ([url, init]) =>
            new URL(String(url)).pathname === '/verify-email' && init?.method === 'POST',
    );
    expect(JSON.parse(String(verification[0]?.[1]?.body))).toEqual({ token: 'synthetic-proof' });
});

it('accepts null Origin only with cookie-bound state, as used by no-referrer document forms', async () => {
    const f = await setup();
    const valid = await f.post(
        { action: 'send', state: f.state, email: 'user@example.com', scope: '' },
        'null',
    );
    expect(await valid.text()).toContain('Check your email');
    const calls = f.fetcher.mock.calls.length;
    const invalid = await f.post(
        { action: 'send', state: 'Z'.repeat(43), email: 'user@example.com' },
        'null',
    );
    expect(invalid.status).toBe(400);
    expect(f.fetcher.mock.calls).toHaveLength(calls);
});
