// SPDX-License-Identifier: MIT
import { readFileSync } from 'node:fs';
import { parseBrowserSsoLoginUi } from './browser-sso.js';
import { SignJWT } from 'jose';
import { afterEach, expect, it, vi } from 'vitest';
import {
    createBrowserSsoClient,
    type BrowserSsoClientOptions,
    type BrowserSsoCookieValue,
} from './browser-sso-client.js';
import { createBrowserSsoBootstrapClient } from './browser-sso-bootstrap-client.js';
import {
    createBrowserSsoBootstrapReceipt,
    hashBrowserSsoToken,
    type BrowserSsoBootstrapReceiptContext,
} from './browser-sso-bootstrap-receipt.js';
import {
    sealBrowserSsoContinuation,
    unsealBrowserSsoContinuation,
    type BrowserSsoContinuation,
} from './browser-sso-continuation.js';
const fixture: {
    keyMaterial: string;
    context: BrowserSsoBootstrapReceiptContext;
    continuation: { cookieName: string; payload: BrowserSsoContinuation; sealed: string };
} = JSON.parse(
    readFileSync(
        new URL('../test/fixtures/browser-sso-bootstrap-v1.json', import.meta.url),
        'utf8',
    ),
);
const options: BrowserSsoClientOptions = {
    mode: 'required',
    loginUi: 'app-owned',
    issuer: fixture.context.issuer,
    audience: fixture.context.audience,
    redirectUri: fixture.context.redirectUri,
    secret: fixture.keyMaterial,
};
const capability = {
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
};
const requestId = 'D'.repeat(43),
    ticket = 'T'.repeat(43);
afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
});
async function token(email = 'user@example.com'): Promise<string> {
    return new SignJWT({ email, siteId: 'app', scope: '*', jti: crypto.randomUUID() })
        .setProtectedHeader({ alg: 'HS256' })
        .setIssuer(options.issuer)
        .setAudience(options.audience)
        .setIssuedAt()
        .setExpirationTime('1h')
        .sign(new TextEncoder().encode(options.secret));
}
async function flow(): Promise<{
    client: ReturnType<typeof createBrowserSsoBootstrapClient>;
    cookies: BrowserSsoCookieValue[];
    query: URLSearchParams;
    state: string;
    fetcher: ReturnType<typeof vi.fn<typeof fetch>>;
    hosted: ReturnType<typeof createBrowserSsoClient>;
}> {
    let state = '';
    const fetcher = vi.fn<typeof fetch>(async (url) =>
        new URL(String(url)).pathname === '/sso/capabilities'
            ? Response.json(capability)
            : Response.json({
                  state,
                  requestId,
                  scope: 'reports',
                  expiresAt: Date.now() + 900_000,
              }),
    );
    const hosted = createBrowserSsoClient({ ...options, fetcher });
    const result = await hosted.start({
        returnUrl: '/reports?q=a%2Bb%20c&tag=1&tag=2',
        cookies: [],
    });
    if (result.kind !== 'redirect') {
        throw new Error('Expected authorize');
    }
    expect(new URL(result.location).searchParams.get('loginUi')).toBe('app-owned');
    state = new URL(result.location).searchParams.get('state') ?? '';
    const query = new URLSearchParams({ state, requestId, ssoPrepared: '1' });
    return {
        client: createBrowserSsoBootstrapClient({ ...options, fetcher }),
        hosted,
        cookies: result.cookies,
        query,
        state,
        fetcher,
    };
}
it('decrypts the independent Python continuation fixture and rejects context substitution', async () => {
    const { cookieName, sealed, payload } = fixture.continuation;
    expect(
        await unsealBrowserSsoContinuation(
            options.secret,
            cookieName,
            sealed,
            fixture.context,
            payload.expiresAt,
            payload.expiresAt - 1,
        ),
    ).toEqual(payload);
    for (const context of [
        { ...fixture.context, audience: 'https://other.example.com' },
        { ...fixture.context, redirectUri: options.audience + '/other' },
        { ...fixture.context, state: 'Z'.repeat(43) },
        { ...fixture.context, issuer: 'https://different.example.com' },
    ]) {
        expect(
            await unsealBrowserSsoContinuation(
                options.secret,
                cookieName,
                sealed,
                context,
                payload.expiresAt,
                payload.expiresAt - 1,
            ),
        ).toBeNull();
    }
    expect(
        await unsealBrowserSsoContinuation(
            options.secret,
            cookieName + 'x',
            sealed,
            fixture.context,
            payload.expiresAt,
            payload.expiresAt - 1,
        ),
    ).toBeNull();
    expect(
        await unsealBrowserSsoContinuation(
            options.secret,
            cookieName,
            sealed,
            fixture.context,
            payload.expiresAt - 1,
            payload.expiresAt - 2,
        ),
    ).toBeNull();
    expect(
        await unsealBrowserSsoContinuation(
            options.secret,
            cookieName,
            sealed,
            fixture.context,
            payload.expiresAt,
            payload.expiresAt,
        ),
    ).toBeNull();
    const resealed = await sealBrowserSsoContinuation(
        options.secret,
        cookieName,
        payload,
        fixture.context,
    );
    expect(resealed.length).toBeLessThan(1536);
    expect(resealed).not.toEqual(sealed);
});
it('requires bootstrap capability before creating state and preserves hosted compatibility', async () => {
    const { appOwnedBootstrapVersion: omitted, ...old } = capability.browserSso;
    expect(omitted).toBe(1);
    for (const extension of [old, { ...old, appOwnedBootstrapVersion: 2 }]) {
        const fetcher = vi.fn<typeof fetch>(async () => Response.json({ browserSso: extension }));
        expect(
            await createBrowserSsoClient({ ...options, fetcher }).start({
                returnUrl: '/',
                cookies: [],
            }),
        ).toEqual({ kind: 'error', error: 'sso_required', cookies: [] });
        expect(
            await createBrowserSsoClient({ ...options, mode: 'auto', fetcher }).start({
                returnUrl: '/',
                cookies: [],
            }),
        ).toEqual({ kind: 'legacy', reason: 'unsupported' });
        expect(
            (
                await createBrowserSsoClient({ ...options, loginUi: 'hosted', fetcher }).start({
                    returnUrl: '/',
                    cookies: [],
                })
            ).kind,
        ).toBe('redirect');
    }
});
it('prepares backend-only PKCE context and finishes without exchanging another JWT', async () => {
    const f = await flow(),
        prepared = await f.client.prepare(f);
    if (!prepared) {
        throw new Error('Expected prepared');
    }
    expect(prepared.scope).toBe('reports');
    expect(prepared.returnUrl).toBe(options.audience + '/reports?q=a%2Bb%20c&tag=1&tag=2');
    const cookies = [...f.cookies, ...prepared.cookies];
    expect(await f.client.context(f.state, cookies)).toEqual(prepared.context);
    expect(await f.client.context(f.state, f.cookies)).toBeNull();
    const jwt = await token();
    const complete = await f.client.complete({
        state: f.state,
        cookies,
        accessToken: jwt,
        response: { browserSso: { bootstrapTicket: ticket } },
    });
    expect(complete?.kind).toBe('redirect');
    if (!complete) {
        throw new Error('Expected ticket');
    }
    const query = new URLSearchParams({
        state: f.state,
        browserSso: 'complete',
        receipt: await createBrowserSsoBootstrapReceipt(options.secret, {
            ...options,
            state: f.state,
            bootstrapTicket: ticket,
            accessTokenHash: await hashBrowserSsoToken(jwt),
        }),
    });
    const finishCookies = [...f.cookies, ...complete.cookies];
    const requests = f.fetcher.mock.calls.length;
    const finish = await f.client.finish({ query, cookies: finishCookies, accessToken: jwt });
    expect(finish).toEqual({
        kind: 'redirect',
        location: prepared.returnUrl,
        cookies: expect.arrayContaining([
            expect.objectContaining({ name: '__Host-magic-sso-tx-' + f.state, maxAge: 0 }),
            expect.objectContaining({
                name: '__Host-magic-sso-continuation-' + f.state,
                maxAge: 0,
            }),
        ]),
    });
    expect(f.fetcher.mock.calls).toHaveLength(requests);
    for (const accessToken of [undefined, 'forged', await token('different@example.com')]) {
        expect((await f.client.finish({ query, cookies: finishCookies, accessToken }))?.kind).toBe(
            'local',
        );
    }
    query.set('receipt', 'Z'.repeat(43));
    expect((await f.client.finish({ query, cookies: finishCookies, accessToken: jwt }))?.kind).toBe(
        'local',
    );
    query.set('state', 'Z'.repeat(43));
    expect(await f.client.finish({ query, cookies: finishCookies, accessToken: jwt })).toBeNull();
    expect(
        await f.client.finish({
            query: new URLSearchParams({ state: f.state, browserSso: 'complete' }),
            cookies,
            accessToken: jwt,
        }),
    ).toBeNull();
});
it('rejects duplicate states/cookies, forged preparation, and expired continuation', async () => {
    const f = await flow();
    const duplicate = new URLSearchParams(f.query);
    duplicate.append('state', f.state);
    expect(await f.client.prepare({ ...f, query: duplicate })).toBeNull();
    expect(await f.client.prepare({ ...f, cookies: [...f.cookies, ...f.cookies] })).toBeNull();
    f.fetcher.mockImplementationOnce(async () =>
        Response.json({ state: 'other', requestId, scope: '', expiresAt: Date.now() + 60_000 }),
    );
    expect(await f.client.prepare(f)).toBeNull();
    const prepared = await f.client.prepare(f);
    if (!prepared) {
        throw new Error('Expected prepared');
    }
    const cookies = [...f.cookies, ...prepared.cookies];
    expect(await f.client.context(f.state, [...cookies, ...prepared.cookies])).toBeNull();
    vi.useFakeTimers();
    vi.setSystemTime(Date.now() + 901_000);
    expect(await f.client.context(f.state, cookies)).toBeNull();
});
it('keeps local verification usable when the issuer returns no ticket, and never accepts an invalid JWT', async () => {
    const f = await flow(),
        prepared = await f.client.prepare(f);
    if (!prepared) {
        throw new Error('Expected prepared');
    }
    const cookies = [...f.cookies, ...prepared.cookies];
    expect(
        (
            await f.client.complete({
                state: f.state,
                cookies,
                accessToken: await token(),
                response: { browserSso: { error: 'request_expired' } },
            })
        )?.kind,
    ).toBe('local');
    expect(
        await f.client.complete({
            state: f.state,
            cookies,
            accessToken: 'forged',
            response: { browserSso: { bootstrapTicket: ticket } },
        }),
    ).toBeNull();
});

it('validates the login UI choice without changing the default', () => {
    expect(parseBrowserSsoLoginUi(undefined)).toBe('hosted');
    expect(parseBrowserSsoLoginUi('app-owned')).toBe('app-owned');
    expect(() => parseBrowserSsoLoginUi('unknown')).toThrow('hosted or app-owned');
});

it('allows explicit fresh hosted recovery without the bootstrap extension', async () => {
    const { appOwnedBootstrapVersion: ignored, ...hosted } = capability.browserSso;
    expect(ignored).toBe(1);
    const client = createBrowserSsoClient({
        ...options,
        fetcher: async () => Response.json({ browserSso: hosted }),
    });
    const result = await client.start({ returnUrl: '/', cookies: [], loginUi: 'hosted' });
    expect(result.kind).toBe('redirect');
    if (result.kind === 'redirect') {
        expect(new URL(result.location).searchParams.has('loginUi')).toBe(false);
    }
});
