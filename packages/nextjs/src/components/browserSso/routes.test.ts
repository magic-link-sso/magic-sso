// SPDX-License-Identifier: MIT
import { SignJWT } from 'jose';
import { NextRequest } from 'next/server';
import { beforeEach, afterEach, describe, expect, it, vi } from 'vitest';
import { BrowserSsoStartRoute, BrowserSsoCallbackRoute, BrowserSsoSignedOutRoute } from './routes';
import { authMiddleware, isPublicPath, buildLoginUrl } from '../../authMiddleware';
import { LogoutRoute } from '../logout/route';

const origin = 'https://app.example.com';
const issuer = 'https://sso.example.com';
const secret = 'fixture-nextjs-jwt-secret-0123456789abcdef';
const capabilities = {
    browserSso: {
        version: 1,
        enabled: true,
        loginUi: 'hosted',
        codeChallengeMethods: ['S256'],
        requestLifetimeSeconds: 900,
        codeLifetimeSeconds: 60,
        transactionLifetimeSeconds: 990,
    },
};
beforeEach(() => {
    vi.stubEnv('MAGICSSO_BROWSER_SSO_MODE', 'required');
    vi.stubEnv('MAGICSSO_PUBLIC_ORIGIN', origin);
    vi.stubEnv('MAGICSSO_SERVER_URL', issuer);
    vi.stubEnv('MAGICSSO_JWT_SECRET', secret);
    vi.stubEnv('MAGICSSO_COOKIE_NAME', 'magic-sso');
    vi.stubEnv('MAGICSSO_COOKIE_PATH', '/');
    vi.stubEnv('MAGICSSO_COOKIE_MAX_AGE', '3600');
});
afterEach(() => {
    vi.unstubAllEnvs();
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
});

async function jwt(email = 'user@example.com', expiresIn = '5m'): Promise<string> {
    return new SignJWT({ email, siteId: 'app', scope: '*', jti: 'fixture-session' })
        .setProtectedHeader({ alg: 'HS256' })
        .setIssuedAt()
        .setExpirationTime(expiresIn)
        .setIssuer(issuer)
        .setAudience(origin)
        .sign(new TextEncoder().encode(secret));
}
async function start(): Promise<{
    state: string;
    cookie: string;
    fetcher: ReturnType<typeof vi.fn<typeof fetch>>;
}> {
    const accessToken = await jwt();
    const fetcher = vi.fn<typeof fetch>(async (input) =>
        Response.json(
            new URL(String(input)).pathname === '/sso/capabilities'
                ? capabilities
                : { accessToken },
        ),
    );
    vi.stubGlobal('fetch', fetcher);
    const response = await BrowserSsoStartRoute(
        new Request(
            `${origin}/sso/start?returnUrl=${encodeURIComponent('/protected?q=a%2Bb%20%26%20c&tag=one&tag=two')}`,
        ),
    );
    expect(response.status).toBe(302);
    const state = new URL(response.headers.get('location') ?? '').searchParams.get('state') ?? '';
    const cookie = response.cookies
        .getAll()
        .map((entry) => `${entry.name}=${entry.value}`)
        .join('; ');
    return { state, cookie, fetcher };
}

describe('Next.js browser SSO', () => {
    const speculativeHeaders: Array<Record<string, string>> = [
        { rsc: '1' },
        { 'next-router-prefetch': '1' },
        { 'sec-purpose': 'prefetch' },
    ];
    it.each(speculativeHeaders)(
        'does not create or consume state during speculative navigation: %j',
        async (headers) => {
            const fetcher = vi.fn<typeof fetch>();
            vi.stubGlobal('fetch', fetcher);
            for (const route of [BrowserSsoStartRoute, BrowserSsoCallbackRoute]) {
                const response = await route(
                    new Request(`${origin}/sso/start?_rsc=probe`, { headers }),
                );
                expect(response.status).toBe(200);
                expect(response.headers.get('content-type')).toContain('text/html');
                expect(response.cookies.getAll()).toHaveLength(0);
            }
            expect(fetcher).not.toHaveBeenCalled();
        },
    );
    it('starts hosted-first regardless of directUse and leaves callback routes public with custom guards', () => {
        const request = new NextRequest(`${origin}/protected?q=one&tag=two`);
        for (const direct of ['false', 'true']) {
            vi.stubEnv('MAGICSSO_DIRECT_USE', direct);
            const target = buildLoginUrl(request, '/protected?q=one&tag=two');
            expect(target.origin + target.pathname).toBe(`${origin}/sso/start`);
            expect(target.searchParams.get('returnUrl')).toBe(`${origin}/protected?q=one&tag=two`);
        }
        for (const path of ['/sso/start', '/sso/callback', '/sso/signed-out']) {
            expect(isPublicPath(path, { excludedPaths: ['/custom'] })).toBe(true);
        }
    });

    it('verifies the callback, caps the app cookie and preserves its full return query', async () => {
        const { state, cookie, fetcher } = await start();
        const response = await BrowserSsoCallbackRoute(
            new Request(`${origin}/sso/callback?state=${state}&code=${'c'.repeat(43)}`, {
                headers: { cookie },
            }),
        );
        expect(response.status).toBe(302);
        expect(response.headers.get('location')).toBe(
            `${origin}/protected?q=a%2Bb%20%26%20c&tag=one&tag=two`,
        );
        expect(response.cookies.get('magic-sso')).toMatchObject({
            httpOnly: true,
            secure: true,
            path: '/',
            sameSite: 'lax',
        });
        expect(response.cookies.get('magic-sso')?.maxAge).toBeLessThanOrEqual(300);
        expect(response.cookies.get(`__Host-magic-sso-tx-${state}`)?.maxAge).toBe(0);
        expect(fetcher).toHaveBeenCalledTimes(2);
    });

    it('rejects mismatched state without exchange or clearing the existing app session', async () => {
        const { cookie, fetcher } = await start();
        const response = await BrowserSsoCallbackRoute(
            new Request(`${origin}/sso/callback?state=${'x'.repeat(43)}&code=${'c'.repeat(43)}`, {
                headers: { cookie: `${cookie}; magic-sso=existing` },
            }),
        );
        expect(response.status).toBe(400);
        expect(response.cookies.getAll()).toHaveLength(0);
        expect(fetcher).toHaveBeenCalledTimes(1);
    });

    it('does not retry an ambiguous exchange or clear an existing app JWT', async () => {
        const { state, cookie, fetcher } = await start();
        fetcher.mockRejectedValue(new Error('Response lost'));
        const response = await BrowserSsoCallbackRoute(
            new Request(`${origin}/sso/callback?state=${state}&code=${'c'.repeat(43)}`, {
                headers: { cookie: `${cookie}; magic-sso=existing` },
            }),
        );
        expect(response.status).toBe(503);
        expect(response.cookies.get('magic-sso')).toBeUndefined();
        expect(response.cookies.get(`__Host-magic-sso-tx-${state}`)?.maxAge).toBe(0);
        expect(fetcher).toHaveBeenCalledTimes(2);
    });

    it('clears its transaction if app cookie configuration fails after exchange', async () => {
        const { state, cookie } = await start();
        vi.stubEnv('MAGICSSO_COOKIE_PATH', 'invalid-path');
        const response = await BrowserSsoCallbackRoute(
            new Request(`${origin}/sso/callback?state=${state}&code=${'c'.repeat(43)}`, {
                headers: { cookie },
            }),
        );
        expect(response.status).toBe(503);
        expect(response.cookies.get(`__Host-magic-sso-tx-${state}`)?.maxAge).toBe(0);
        expect(response.cookies.get('magic-sso')).toBeUndefined();
    });

    it('keeps pending callbacks public and reports disabling instead of falling back', async () => {
        const { state, cookie, fetcher } = await start();
        vi.stubEnv('MAGICSSO_BROWSER_SSO_MODE', 'off');
        expect(isPublicPath('/sso/callback', { excludedPaths: [] })).toBe(true);
        const response = await BrowserSsoCallbackRoute(
            new Request(`${origin}/sso/callback?state=${state}&code=${'c'.repeat(43)}`, {
                headers: { cookie },
            }),
        );
        expect(response.status).toBe(409);
        expect(response.headers.get('location')).toBeNull();
        expect(fetcher).toHaveBeenCalledTimes(1);
    });

    it('returns to legacy login only after explicit unsupported discovery in auto mode', async () => {
        vi.stubEnv('MAGICSSO_BROWSER_SSO_MODE', 'auto');
        vi.stubEnv('MAGICSSO_DIRECT_USE', 'false');
        vi.stubGlobal(
            'fetch',
            vi.fn(async () => new Response('', { status: 404 })),
        );
        const response = await BrowserSsoStartRoute(
            new Request(`${origin}/sso/start?returnUrl=%2Fprotected`),
        );
        expect(response.headers.get('location')).toContain(`${origin}/login?returnUrl=`);
        expect(response.cookies.getAll()).toHaveLength(0);
    });

    it('retains a valid existing app identity and starts SSO only when its JWT expires', async () => {
        const active = new NextRequest(`${origin}/protected`, {
            headers: { cookie: `magic-sso=${await jwt('old@example.com')}` },
        });
        expect((await authMiddleware(active)).headers.get('x-middleware-next')).toBe('1');
        const expired = new NextRequest(`${origin}/protected?q=one`, {
            headers: { cookie: `magic-sso=${await jwt('old@example.com', '-1s')}` },
        });
        expect((await authMiddleware(expired)).headers.get('location')).toContain(
            `${origin}/sso/start?`,
        );
    });

    it('keeps local sign-out public with a separate central confirmation action', async () => {
        const done = await LogoutRoute(
            new Request(`${origin}/logout`, { method: 'POST', headers: { origin } }),
        );
        expect(done.headers.get('location')).toBe(`${origin}/sso/signed-out`);
        const page = await BrowserSsoSignedOutRoute(new Request(`${origin}/sso/signed-out`));
        expect(page.status).toBe(200);
        expect(page.headers.get('location')).toBeNull();
        const html = await page.text();
        expect(html).toContain('Signed out of this application');
        expect(html).toContain('End browser SSO session');
        expect(html).toContain('returnUri=');
    });

    it('trusts the configured public origin ahead of forged forwarding headers', async () => {
        await start();
        const response = await BrowserSsoStartRoute(
            new Request('http://backend.internal/sso/start', {
                headers: { 'x-forwarded-host': 'evil.test', 'x-forwarded-proto': 'http' },
            }),
        );
        expect(
            new URL(response.headers.get('location') ?? '').searchParams.get('redirectUri'),
        ).toBe(`${origin}/sso/callback`);
    });

    it('rejects POST entry points without changing cookies', async () => {
        const response = await BrowserSsoCallbackRoute(
            new Request(`${origin}/sso/callback`, { method: 'POST' }),
        );
        expect(response.status).toBe(405);
        expect(response.headers.get('allow')).toBe('GET');
        expect(response.cookies.getAll()).toHaveLength(0);
    });
});

it('mounts application-owned forms with multiple HttpOnly cookies and accepts POST at the start route', async () => {
    vi.stubEnv('MAGICSSO_BROWSER_SSO_LOGIN_UI', 'app-owned');
    let state = '';
    vi.stubGlobal('fetch', async (url: string | URL | Request) =>
        Response.json(
            new URL(String(url)).pathname === '/sso/capabilities'
                ? { browserSso: { ...capabilities.browserSso, appOwnedBootstrapVersion: 1 } }
                : { state, requestId: 'R'.repeat(43), scope: '', expiresAt: Date.now() + 900_000 },
        ),
    );
    const start = await BrowserSsoStartRoute(new Request(origin + '/sso/start'));
    expect(start.status).toBe(303);
    const target = new URL(start.headers.get('location') ?? '');
    expect(target.searchParams.get('loginUi')).toBe('app-owned');
    state = target.searchParams.get('state') ?? '';
    const prepared = await BrowserSsoStartRoute(
        new Request(
            origin +
                '/sso/start?' +
                new URLSearchParams({ state, requestId: 'R'.repeat(43), ssoPrepared: '1' }),
            {
                headers: {
                    cookie: start.cookies
                        .getAll()
                        .map((c) => `${c.name}=${c.value}`)
                        .join('; '),
                },
            },
        ),
    );
    expect(await prepared.text()).toContain('Send magic link');
    expect(prepared.cookies.getAll()).toHaveLength(1);
    expect(prepared.cookies.getAll()[0]?.name).toBe('__Host-magic-sso-continuation-' + state);
    expect(
        (
            await BrowserSsoStartRoute(
                new Request(origin + '/sso/start', {
                    method: 'POST',
                    headers: {
                        origin: 'https://attacker.example',
                        'content-type': 'application/x-www-form-urlencoded',
                    },
                    body: 'action=send',
                }),
            )
        ).status,
    ).toBe(400);
});
