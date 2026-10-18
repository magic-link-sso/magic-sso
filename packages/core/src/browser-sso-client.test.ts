// SPDX-License-Identifier: MIT
import { readFileSync } from 'node:fs';
import { SignJWT } from 'jose';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
    createBrowserSsoClient,
    parseBrowserSsoCookies,
    isBrowserSsoDocumentNavigation,
    type BrowserSsoClientOptions,
    type BrowserSsoCookieValue,
} from './browser-sso-client.js';
import {
    createBrowserSsoCodeChallenge,
    createBrowserSsoRandomValue,
    sealBrowserSsoTransaction,
    unsealBrowserSsoTransaction,
    type BrowserSsoTransactionPayload,
} from './browser-sso-transaction.js';

const fixture: {
    enabled: unknown;
    transaction: {
        keyMaterial: string;
        cookieName: string;
        sealed: string;
        payload: BrowserSsoTransactionPayload;
    };
} = JSON.parse(
    readFileSync(new URL('../test/fixtures/browser-sso-v1.json', import.meta.url), 'utf8'),
);
const options: BrowserSsoClientOptions = {
    mode: 'required',
    issuer: 'https://sso.example.com',
    audience: 'https://app.example.com',
    redirectUri: 'https://app.example.com/sso/callback',
    secret: 'fixture-browser-app-jwt-secret-0123456789abcdef',
};
afterEach(() => {
    vi.restoreAllMocks();
});

async function token(
    overrides: { issuer?: string; audience?: string; secret?: string } = {},
): Promise<string> {
    return new SignJWT({
        email: 'user@example.com',
        siteId: 'app',
        scope: '*',
        jti: createBrowserSsoRandomValue(),
    })
        .setProtectedHeader({ alg: 'HS256' })
        .setIssuedAt()
        .setExpirationTime('1h')
        .setIssuer(overrides.issuer ?? options.issuer)
        .setAudience(overrides.audience ?? options.audience)
        .sign(new TextEncoder().encode(overrides.secret ?? options.secret));
}

async function flow(): Promise<{
    client: ReturnType<typeof createBrowserSsoClient>;
    fetcher: ReturnType<typeof vi.fn<typeof fetch>>;
    query: URLSearchParams;
    cookies: BrowserSsoCookieValue[];
    location: URL;
}> {
    const jwt = await token();
    const fetcher = vi.fn<typeof fetch>(async (url) =>
        new URL(String(url)).pathname === '/sso/capabilities'
            ? Response.json(fixture.enabled)
            : Response.json({ accessToken: jwt }),
    );
    const client = createBrowserSsoClient({ ...options, fetcher });
    const result = await client.start({
        returnUrl: '/reports?q=a%2Bb%20%26%20c&tag=one&tag=two',
        cookies: [],
    });
    if (result.kind !== 'redirect') {
        throw new Error('Expected SSO redirect');
    }
    const location = new URL(result.location);
    return {
        client,
        fetcher,
        cookies: result.cookies,
        location,
        query: new URLSearchParams({
            state: location.searchParams.get('state') ?? '',
            code: createBrowserSsoRandomValue(),
        }),
    };
}

describe('portable browser SSO transactions', () => {
    it('decrypts the independent v1 cross-language fixture and reports expiry separately', async () => {
        const { payload, sealed, cookieName, keyMaterial } = fixture.transaction;
        expect(
            await unsealBrowserSsoTransaction(
                keyMaterial,
                cookieName,
                sealed,
                payload,
                payload.createdAt,
            ),
        ).toEqual({ kind: 'valid', payload });
        expect(
            await unsealBrowserSsoTransaction(
                keyMaterial,
                cookieName,
                sealed,
                payload,
                payload.expiresAt,
            ),
        ).toEqual({ kind: 'expired', payload });
    });

    it('uses fresh random state, verifiers and nonces and rejects tampering or another app', async () => {
        const example = fixture.transaction;
        const first = await sealBrowserSsoTransaction(
            example.keyMaterial,
            example.cookieName,
            example.payload,
        );
        const second = await sealBrowserSsoTransaction(
            example.keyMaterial,
            example.cookieName,
            example.payload,
        );
        expect(first).not.toBe(second);
        for (const [name, value, context, secret] of [
            [example.cookieName + 'x', first, example.payload, example.keyMaterial],
            [
                example.cookieName,
                first.slice(0, -1) + (first.endsWith('A') ? 'B' : 'A'),
                example.payload,
                example.keyMaterial,
            ],
            [
                example.cookieName,
                first,
                { ...example.payload, audience: 'https://other.example.com' },
                example.keyMaterial,
            ],
            [
                example.cookieName,
                first,
                example.payload,
                'other-long-enough-jwt-secret-0123456789abcdef',
            ],
        ] satisfies Array<[string, string, BrowserSsoTransactionPayload, string]>) {
            expect(
                await unsealBrowserSsoTransaction(
                    secret,
                    name,
                    value,
                    context,
                    example.payload.createdAt,
                ),
            ).toBeNull();
        }
        const verifier = createBrowserSsoRandomValue();
        expect(verifier).toMatch(/^[A-Za-z0-9_-]{43}$/);
        expect(createBrowserSsoRandomValue()).not.toBe(verifier);
        expect(
            await createBrowserSsoCodeChallenge('dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk'),
        ).toBe('E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM');
    });
});

describe('portable hosted browser SSO client', () => {
    const speculativeHeaders: Array<Record<string, string>> = [
        { rsc: '1' },
        { 'next-router-prefetch': '1' },
        { purpose: 'prefetch' },
        { 'sec-purpose': 'prefetch;prerender' },
        { 'sec-fetch-mode': 'cors' },
        { 'sec-fetch-mode': 'navigate', 'sec-fetch-dest': 'iframe' },
        { 'sec-fetch-mode': 'navigate', 'sec-fetch-dest': 'frame' },
    ];
    it.each(speculativeHeaders)(
        'rejects speculative/fetch navigation for auth state: %j',
        (headers) => {
            expect(isBrowserSsoDocumentNavigation(new Headers(headers))).toBe(false);
            expect(
                isBrowserSsoDocumentNavigation(new Headers({ 'sec-fetch-mode': 'navigate' })),
            ).toBe(true);
            expect(isBrowserSsoDocumentNavigation(new Headers())).toBe(true);
        },
    );
    it('retains duplicate cookie names for rejecting ambiguous callbacks', () => {
        expect(parseBrowserSsoCookies('tx=first; tx=second; value=v1%2Esealed; broken=%')).toEqual([
            { name: 'tx', value: 'first' },
            { name: 'tx', value: 'second' },
            { name: 'value', value: 'v1.sealed' },
            { name: 'broken', value: '%' },
        ]);
    });
    it('seals PKCE, exchanges once on the backend, verifies JWT and preserves the full return query', async () => {
        const { client, fetcher, query, cookies, location } = await flow();
        expect(location.origin).toBe(options.issuer);
        expect(location.searchParams.get('codeChallengeMethod')).toBe('S256');
        expect(cookies[0]).toMatchObject({
            httpOnly: true,
            secure: true,
            path: '/',
            sameSite: 'lax',
        });
        const result = await client.callback({ query, cookies });
        expect(result).toMatchObject({
            kind: 'authenticated',
            auth: { email: 'user@example.com', siteId: 'app' },
            returnUrl: `${options.audience}/reports?q=a%2Bb%20%26%20c&tag=one&tag=two`,
        });
        expect(fetcher).toHaveBeenCalledTimes(2);
        expect(result.cookies).toEqual([
            expect.objectContaining({ name: cookies[0]?.name, maxAge: 0, value: '' }),
        ]);
        const request = fetcher.mock.calls[1]?.[1];
        expect(request).toMatchObject({ method: 'POST', redirect: 'error', cache: 'no-store' });
        const body: { codeVerifier: string } = JSON.parse(String(request?.body));
        expect(await createBrowserSsoCodeChallenge(body.codeVerifier)).toBe(
            location.searchParams.get('codeChallenge'),
        );
        expect(cookies[0]?.value).not.toContain(body.codeVerifier);
    });

    it.each([
        'wrong-state',
        'missing-state',
        'duplicate-state',
        'tampered-cookie',
        'duplicate-cookie',
    ])('never exchanges or clears another transaction for %s', async (scenario) => {
        const current = await flow();
        if (scenario === 'wrong-state') {
            current.query.set('state', createBrowserSsoRandomValue());
        }
        if (scenario === 'missing-state') {
            current.query.delete('state');
        }
        if (scenario === 'duplicate-state') {
            current.query.append('state', current.query.get('state') ?? '');
        }
        if (scenario === 'tampered-cookie' && current.cookies[0]) {
            current.cookies[0].value += 'x';
        }
        if (scenario === 'duplicate-cookie' && current.cookies[0]) {
            current.cookies.push(current.cookies[0]);
        }
        expect(await current.client.callback(current)).toEqual({
            kind: 'error',
            error: 'invalid_transaction',
            cookies: [],
        });
        expect(current.fetcher).toHaveBeenCalledTimes(1);
    });

    it('keeps three independent transactions, rejects a fourth and clears only the completed tab', async () => {
        const { client, cookies, query } = await flow();
        const all = [...cookies];
        for (let i = 0; i < 2; i += 1) {
            const next = await client.start({ cookies: all, returnUrl: `/tab-${i}` });
            if (next.kind !== 'redirect') {
                throw new Error('Expected next tab');
            }
            all.push(...next.cookies);
        }
        expect(await client.start({ cookies: all, returnUrl: '/fourth' })).toEqual({
            kind: 'error',
            error: 'transaction_limit',
            cookies: [],
        });
        const completed = await client.callback({ query, cookies: all });
        expect(completed.kind).toBe('authenticated');
        expect(completed.cookies.map((entry) => entry.name)).toEqual([cookies[0]?.name]);
    });

    it('prunes expired own cookies and never exchanges an expired callback', async () => {
        const { client, cookies, query } = await flow();
        const now = Date.now();
        vi.spyOn(Date, 'now').mockReturnValue(now + 991_000);
        const rejected = await client.callback({ query, cookies });
        expect(rejected).toMatchObject({
            kind: 'error',
            error: 'transaction_expired',
            cookies: [expect.objectContaining({ maxAge: 0 })],
        });
        const restarted = await client.start({ cookies, returnUrl: '/' });
        expect(restarted).toMatchObject({
            kind: 'redirect',
            cookies: [
                expect.objectContaining({ maxAge: 0 }),
                expect.objectContaining({ maxAge: 990 }),
            ],
        });
    });

    it('rejects oversized starts without disturbing existing transactions', async () => {
        const { client, cookies } = await flow();
        expect(await client.start({ cookies, returnUrl: '/' + 'x'.repeat(513) })).toEqual({
            kind: 'error',
            error: 'transaction_too_large',
            cookies: [],
        });
        const large = createBrowserSsoClient({
            ...options,
            redirectUri: `${options.audience}/${'x'.repeat(900)}`,
            fetcher: async () => Response.json(fixture.enabled),
        });
        expect(await large.start({ cookies, returnUrl: '/' })).toEqual({
            kind: 'error',
            error: 'transaction_too_large',
            cookies: [],
        });
    });

    it.each([404, 'disabled', 'unsupported'])(
        'auto falls back only for explicit %s support before creating cookies',
        async (support) => {
            const fetcher = vi.fn<typeof fetch>(async () =>
                support === 404
                    ? new Response('', { status: 404 })
                    : Response.json({
                          browserSso: {
                              version: support === 'unsupported' ? 2 : 1,
                              enabled: false,
                          },
                      }),
            );
            const client = createBrowserSsoClient({ ...options, mode: 'auto', fetcher });
            expect((await client.start({ cookies: [], returnUrl: '/' })).kind).toBe('legacy');
            const required = createBrowserSsoClient({ ...options, fetcher });
            expect(await required.start({ cookies: [], returnUrl: '/' })).toMatchObject({
                kind: 'error',
                error: 'sso_required',
                cookies: [],
            });
        },
    );

    it.each(['malformed', 'missing', '5xx', 'redirect', 'timeout'])(
        'never falls back on %s discovery failures',
        async (failure) => {
            const fetcher = vi.fn<typeof fetch>(async () => {
                if (failure === 'timeout') {
                    throw new Error('timeout');
                }
                if (failure === '5xx') {
                    return new Response('', { status: 503 });
                }
                if (failure === 'redirect') {
                    return new Response('', {
                        status: 302,
                        headers: { location: 'https://evil.test' },
                    });
                }
                return Response.json(
                    failure === 'missing' ? {} : { browserSso: { version: 1, enabled: true } },
                );
            });
            const client = createBrowserSsoClient({ ...options, mode: 'auto', fetcher });
            expect(await client.start({ cookies: [], returnUrl: '/' })).toEqual({
                kind: 'error',
                error: 'temporarily_unavailable',
                cookies: [],
            });
        },
    );

    it('caches capabilities for no longer than sixty seconds and fixes the trusted issuer at creation', async () => {
        const { client, fetcher } = await flow();
        await client.start({ cookies: [], returnUrl: '/' });
        expect(fetcher).toHaveBeenCalledTimes(1);
        vi.spyOn(Date, 'now').mockReturnValue(Date.now() + 60_001);
        await client.start({ cookies: [], returnUrl: '/' });
        expect(fetcher).toHaveBeenCalledTimes(2);
        const configuration = { ...options, fetcher };
        const fixed = createBrowserSsoClient(configuration);
        configuration.issuer = 'https://evil.test';
        await fixed.start({ cookies: [], returnUrl: '/' });
        expect(String(fetcher.mock.calls.at(-1)?.[0])).toBe(`${options.issuer}/sso/capabilities`);
    });

    it.each([
        { audience: 'https://other.test' },
        { issuer: 'https://other.test' },
        { secret: 'other-long-enough-signing-secret-123456' },
    ])('rejects a JWT with mismatched %j', async (override) => {
        const current = await flow();
        current.fetcher.mockResolvedValue(Response.json({ accessToken: await token(override) }));
        expect(await current.client.callback(current)).toMatchObject({
            kind: 'error',
            error: 'invalid_token',
            cookies: [expect.objectContaining({ maxAge: 0 })],
        });
    });

    it('does not retry a code or fall back after an ambiguous exchange failure', async () => {
        const current = await flow();
        current.fetcher.mockRejectedValue(new Error('Connection lost after consumption'));
        const result = await current.client.callback(current);
        expect(result).toMatchObject({
            kind: 'error',
            error: 'exchange_failed',
            returnUrl: expect.stringContaining('/reports?'),
        });
        expect(current.fetcher).toHaveBeenCalledTimes(2);
    });

    it.each([
        { issuer: options.audience },
        { audience: 'http://app.example.com' },
        { redirectUri: `${options.redirectUri}?next=x` },
        { secret: '' },
        { timeoutMs: 1 },
    ])('rejects unsafe configuration: %j', (override) => {
        expect(() => createBrowserSsoClient({ ...options, ...override })).toThrow();
    });
});
