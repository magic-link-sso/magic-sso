// SPDX-License-Identifier: MIT
import { SignJWT } from 'jose';
import type { FastifyInstance, LightMyRequestResponse } from 'fastify';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createApp, type GateProxyServer } from './app.js';
import { loadConfig, resolveGateConfig, type GateConfigInput } from './config.js';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createServer } from 'node:http';

const base = {
    publicOrigin: 'https://gate.example.com',
    serverUrl: 'https://sso.example.com',
    upstreamUrl: 'http://upstream.internal',
    jwtSecret: 'fixture-gate-shared-jwt-secret-0123456789abc',
    previewSecret: 'fixture-gate-preview-secret-0123456789abc',
    browserSso: { mode: 'required' },
    cookieMaxAge: 3600,
} satisfies GateConfigInput;
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
const apps: FastifyInstance[] = [];
afterEach(async () => {
    await Promise.all(apps.splice(0).map((app) => app.close()));
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
});

async function create(
    overrides: GateConfigInput = {},
    proxy?: GateProxyServer,
): Promise<FastifyInstance> {
    const app = await createApp({
        config: { ...base, ...overrides },
        logger: false,
        ...(proxy ? { proxyFactory: () => proxy } : {}),
    });
    apps.push(app);
    return app;
}
function cookies(response: LightMyRequestResponse): Record<string, string> {
    return Object.fromEntries(response.cookies.map((cookie) => [cookie.name, cookie.value]));
}
async function jwt(email = 'owner@example.com'): Promise<string> {
    return new SignJWT({ email, jti: 'fixture-session-id', scope: '*', siteId: 'gate' })
        .setProtectedHeader({ alg: 'HS256' })
        .setIssuedAt()
        .setExpirationTime('5m')
        .setAudience('https://gate.example.com')
        .setIssuer('https://sso.example.com')
        .sign(new TextEncoder().encode(base.jwtSecret));
}
function fakeIssuer(accessToken: string): ReturnType<typeof vi.fn<typeof fetch>> {
    const fetcher = vi.fn<typeof fetch>(async (input) => {
        const path = new URL(String(input)).pathname;
        return Response.json(
            path === '/sso/capabilities'
                ? capabilities
                : path === '/sso/exchange'
                  ? { accessToken }
                  : { revoked: false },
        );
    });
    vi.stubGlobal('fetch', fetcher);
    return fetcher;
}

describe('Gate browser SSO routes', () => {
    it('creates no cookies or exchanges during speculative or fetched navigation', async () => {
        const app = await create();
        const fetcher = fakeIssuer(await jwt());
        for (const path of ['/_magicgate/sso/start', '/_magicgate/sso/callback']) {
            const response = await app.inject({
                url: path,
                headers: { 'sec-purpose': 'prefetch' },
            });
            expect(response.statusCode).toBe(200);
            expect(response.cookies).toHaveLength(0);
            expect(response.body).toContain('Continue sign-in');
        }
        expect(fetcher).not.toHaveBeenCalled();
    });
    it.each(['subdomain', 'path-prefix'])(
        'starts and completes a namespaced flow with a full query in %s mode',
        async (mode) => {
            const prefix = mode === 'path-prefix' ? '/private' : '';
            const namespace = `${prefix}/_access`;
            const app = await create({
                mode: mode === 'path-prefix' ? 'path-prefix' : 'subdomain',
                publicPathPrefix: prefix,
                namespace: '/_access',
            });
            const fetcher = fakeIssuer(await jwt());
            const destination = `${prefix}/reports?q=a%2Bb%20%26%20c&tag=one&tag=two`;
            const protectedResponse = await app.inject({
                url: destination,
                headers: { accept: 'text/html' },
            });
            expect(protectedResponse.statusCode).toBe(302);
            expect(protectedResponse.headers.location).toContain(`${namespace}/sso/start?`);
            const started = await app.inject(protectedResponse.headers.location ?? '');
            const authorize = new URL(started.headers.location ?? '');
            expect(authorize.origin).toBe(base.serverUrl);
            expect(authorize.searchParams.get('redirectUri')).toBe(
                `${base.publicOrigin}${namespace}/sso/callback`,
            );
            const callback = await app.inject({
                url: `${namespace}/sso/callback?${new URLSearchParams({ state: authorize.searchParams.get('state') ?? '', code: 'c'.repeat(43) })}`,
                cookies: cookies(started),
            });
            expect(callback.statusCode).toBe(302);
            expect(callback.headers.location).toBe(`${base.publicOrigin}${destination}`);
            expect(callback.cookies.find((cookie) => cookie.name === 'magic-sso')).toMatchObject({
                httpOnly: true,
                secure: true,
                sameSite: 'Lax',
                path: prefix || '/',
            });
            expect(
                callback.cookies.find((cookie) => cookie.name === 'magic-sso')?.maxAge,
            ).toBeLessThanOrEqual(300);
            expect(
                callback.cookies.filter((cookie) => cookie.name.startsWith('__Host-magic-sso-tx-')),
            ).toEqual([expect.objectContaining({ value: '', maxAge: 0, path: '/' })]);
            expect(fetcher).toHaveBeenCalledTimes(2);
            expect(callback.headers['cache-control']).toBe('no-store');
        },
    );

    it('keeps a local sign-out public and requires an explicit new sign-in', async () => {
        const app = await create();
        const fetcher = fakeIssuer(await jwt());
        const done = await app.inject({
            method: 'POST',
            url: '/_magicgate/logout',
            cookies: { 'magic-sso': await jwt() },
            headers: { origin: base.publicOrigin ?? '' },
        });
        expect(done.statusCode).toBe(302);
        expect(done.headers.location).toBe('/_magicgate/signed-out');
        const count = fetcher.mock.calls.length;
        const page = await app.inject(done.headers.location ?? '');
        expect(page.statusCode).toBe(200);
        expect(page.headers.location).toBeUndefined();
        expect(page.body).toContain('Signed out of this application');
        expect(page.body).toContain('/_magicgate/sso/start?');
        expect(page.body).toContain('End browser SSO session');
        expect(page.body).toContain(
            'returnUri=https%3A%2F%2Fgate.example.com%2F_magicgate%2Fsigned-out',
        );
        expect(fetcher).toHaveBeenCalledTimes(count);
    });

    it('falls back before setting transaction cookies only when auto discovers an older issuer', async () => {
        const app = await create({ browserSso: { mode: 'auto' } });
        vi.stubGlobal(
            'fetch',
            vi.fn(async () => new Response('', { status: 404 })),
        );
        const legacy = await app.inject('/_magicgate/sso/start?returnUrl=%2Freports');
        expect(legacy.statusCode).toBe(302);
        expect(legacy.headers.location).toBe(
            '/_magicgate/login?returnUrl=https%3A%2F%2Fgate.example.com%2Freports',
        );
        expect(legacy.cookies).toHaveLength(0);
        const required = await create();
        expect((await required.inject('/_magicgate/sso/start')).statusCode).toBe(503);
    });

    it('rejects wrong state without clearing another transaction or an existing app session', async () => {
        const app = await create();
        const fetcher = fakeIssuer(await jwt());
        const started = await app.inject('/_magicgate/sso/start');
        const response = await app.inject({
            url: `/_magicgate/sso/callback?state=${'x'.repeat(43)}&code=${'c'.repeat(43)}`,
            cookies: { ...cookies(started), 'magic-sso': await jwt('existing@example.com') },
        });
        expect(response.statusCode).toBe(400);
        expect(response.cookies).toHaveLength(0);
        expect(fetcher).toHaveBeenCalledTimes(1);
    });

    it('keeps transactions and verification cookies out of authenticated upstream requests', async () => {
        let forwarded = '';
        const proxy: GateProxyServer = {
            on(): void {},
            close(): void {},
            ws(): void {},
            web(request, response): void {
                forwarded = request.headers.cookie ?? '';
                response.writeHead(200);
                response.end('protected');
            },
        };
        const app = await create({}, proxy);
        fakeIssuer(await jwt());
        const response = await app.inject({
            url: '/protected',
            headers: {
                cookie: `magic-sso=${await jwt()}; __Host-magic-sso-tx-state=sealed; magic-sso-tx-other=sealed; __Host-magic-sso-continuation-state=private; magic-sso-confirm-state=csrf; magic-sso.verify-token=proof; magic-sso.verify-csrf=csrf; magic-sso.otp-challenge=otp; preferences=kept`,
            },
        });
        expect(response.statusCode).toBe(200);
        expect(forwarded).toBe('preferences=kept');
    });

    it('blocks upstream responses from overwriting transaction cookies', async () => {
        const upstream = createServer((_request, response) => {
            response.writeHead(200, {
                'set-cookie': [
                    '__Host-magic-sso-tx-attacker=bad; Path=/; Secure',
                    'magic-sso-tx-attacker=bad; Path=/',
                    '__Host-magic-sso-continuation-attacker=bad; Path=/; Secure',
                    'magic-sso-confirm-attacker=bad; Path=/',
                    'magic-sso=bad; Path=/',
                    'preferences=kept; Path=/',
                ],
            });
            response.end('protected');
        });
        await new Promise<void>((resolve, reject) => {
            upstream.once('error', reject);
            upstream.listen(0, '127.0.0.1', resolve);
        });
        try {
            const address = upstream.address();
            if (!address || typeof address === 'string') {
                throw new Error('Missing upstream port');
            }
            const app = await create({ upstreamUrl: `http://127.0.0.1:${address.port}` });
            fakeIssuer(await jwt());
            const response = await app.inject({
                url: '/protected',
                cookies: { 'magic-sso': await jwt() },
            });
            expect(response.statusCode).toBe(200);
            expect(response.headers['set-cookie']).toEqual(['preferences=kept; Path=/']);
        } finally {
            upstream.closeAllConnections();
            await new Promise<void>((resolve, reject) => {
                upstream.close((error) => (error ? reject(error) : resolve()));
            });
        }
    });

    it('removes code, state and PKCE fields from automatic callback logging', async () => {
        const logs: string[] = [];
        const app = await createApp({
            config: base,
            logger: {
                level: 'info',
                stream: {
                    write(chunk: string): void {
                        logs.push(chunk);
                    },
                },
            },
        });
        apps.push(app);
        fakeIssuer(await jwt());
        const started = await app.inject('/_magicgate/sso/start');
        const authorize = new URL(started.headers.location ?? '');
        const state = authorize.searchParams.get('state') ?? '';
        await app.inject({
            url: `/_magicgate/sso/callback?state=${state}&code=${'c'.repeat(43)}`,
            cookies: cookies(started),
        });
        expect(logs.join('')).toContain('/_magicgate/sso/callback');
        expect(logs.join('')).not.toContain(state);
        expect(logs.join('')).not.toContain('c'.repeat(43));
    });
});

describe('Gate browser SSO configuration', () => {
    it('keeps participation opt-in and reads strict TOML policy', async () => {
        expect(resolveGateConfig({ ...base, browserSso: { mode: 'off' } }).browserSso.mode).toBe(
            'off',
        );
        const directory = await mkdtemp(join(tmpdir(), 'magic-gate-sso-config-'));
        const path = join(directory, 'gate.toml');
        try {
            await writeFile(
                path,
                `[gate]\npublicOrigin = "https://gate.example.com"\nupstreamUrl = "http://upstream.internal"\n[auth]\njwtSecret = "${base.jwtSecret}"\npreviewSecret = "${base.previewSecret}"\nserverUrl = "${base.serverUrl}"\n[auth.sso]\nmode = "auto"\nrequestTimeoutMs = 3000\n`,
            );
            expect(loadConfig({ MAGIC_GATE_CONFIG_FILE: path }).browserSso).toEqual({
                mode: 'auto',
                requestTimeoutMs: 3000,
                allowInsecureLocalhost: false,
            });
        } finally {
            await rm(directory, { recursive: true, force: true });
        }
    });

    it('rejects enabling a shared issuer/app hostname before opening resources', async () => {
        await expect(create({ serverUrl: base.publicOrigin })).rejects.toThrow(
            'distinct issuer/app hostnames',
        );
    });
});

it('mounts app-owned forms below the Gate namespace and protects POST with the original state', async () => {
    let state = '';
    const fetcher = vi.fn<typeof fetch>(async (input) =>
        Response.json(
            new URL(String(input)).pathname === '/sso/capabilities'
                ? { browserSso: { ...capabilities.browserSso, appOwnedBootstrapVersion: 1 } }
                : { state, requestId: 'R'.repeat(43), scope: '', expiresAt: Date.now() + 900_000 },
        ),
    );
    vi.stubGlobal('fetch', fetcher);
    const app = await create({ browserSso: { mode: 'required', loginUi: 'app-owned' } });
    const start = await app.inject('/_magicgate/sso/start?returnUrl=%2Fprotected');
    const target = new URL(String(start.headers.location));
    expect(target.searchParams.get('loginUi')).toBe('app-owned');
    state = target.searchParams.get('state') ?? '';
    const prepared = await app.inject({
        url:
            '/_magicgate/sso/start?' +
            new URLSearchParams({ state, requestId: 'R'.repeat(43), ssoPrepared: '1' }),
        cookies: cookies(start),
    });
    expect(prepared.body).toContain('action="/_magicgate/sso/start"');
    expect(prepared.headers['content-security-policy']).toContain(
        "form-action 'self' https://sso.example.com",
    );
    expect(prepared.headers['content-security-policy']).toContain("script-src 'none'");
    expect(prepared.cookies[0]?.name).toBe('__Host-magic-sso-continuation-' + state);
    expect(
        (
            await app.inject({
                method: 'POST',
                url: '/_magicgate/sso/start',
                headers: {
                    origin: 'https://attacker.example',
                    'content-type': 'application/x-www-form-urlencoded',
                },
                payload: 'action=send&state=' + state,
            })
        ).statusCode,
    ).toBe(400);
});
