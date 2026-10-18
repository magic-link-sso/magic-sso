// SPDX-License-Identifier: MIT
import { readFileSync } from 'node:fs';
import { SignJWT } from 'jose';
import { describe, expect, it, vi } from 'vitest';
import { createBrowserSsoHttpHandler, type BrowserSsoHttpOptions } from './browser-sso-http.js';
import { createBrowserSsoRandomValue } from './browser-sso-transaction.js';
import { parseBrowserSsoMode } from './browser-sso.js';

const fixture: { enabled: unknown } = JSON.parse(
    readFileSync(new URL('../test/fixtures/browser-sso-v1.json', import.meta.url), 'utf8'),
);
const options: BrowserSsoHttpOptions = {
    mode: 'required',
    issuer: 'https://sso.example.com',
    audience: 'https://app.example.com',
    redirectUri: 'https://app.example.com/sso/callback',
    secret: 'test-browser-sso-http-secret-0123456789',
    cookieName: 'app-token',
    cookiePath: '/private',
    cookieMaxAge: 7200,
};
function request(path: string, headers?: HeadersInit): Request {
    return new Request(new URL(path, options.audience), { headers });
}
describe('portable SSO HTTP routes', () => {
    it('issues an app session only after a matching sealed transaction and verified backend JWT', async () => {
        const token = await new SignJWT({
            email: 'owner@example.com',
            siteId: 'app',
            scope: '*',
            jti: 'test',
        })
            .setProtectedHeader({ alg: 'HS256' })
            .setIssuedAt()
            .setExpirationTime('60s')
            .setIssuer(options.issuer)
            .setAudience(options.audience)
            .sign(new TextEncoder().encode(options.secret));
        const fetcher = vi.fn<typeof fetch>(async (url) =>
            new URL(String(url)).pathname === '/sso/capabilities'
                ? Response.json(fixture.enabled)
                : Response.json({ accessToken: token }),
        );
        const handler = createBrowserSsoHttpHandler({ ...options, fetcher });
        const destination = '/private?filter=a%2Bb&tag=one&tag=two';
        const start = await handler(
            request('/sso/start?' + new URLSearchParams({ returnUrl: destination })),
        );
        expect(start.status).toBe(303);
        const auth = new URL(start.headers.get('location') ?? '');
        const cookie = start.headers.getSetCookie()[0]?.split(';')[0] ?? '';
        expect(cookie).toMatch(/^__Host-magic-sso-tx-/u);
        expect(start.headers.getSetCookie()[0]).toContain('Path=/; HttpOnly; SameSite=Lax; Secure');
        const callback =
            '/sso/callback?' +
            new URLSearchParams({
                state: auth.searchParams.get('state') ?? '',
                code: createBrowserSsoRandomValue(),
            });
        const success = await handler(request(callback, { cookie }));
        expect(success.status).toBe(303);
        expect(success.headers.get('location')).toBe(options.audience + destination);
        expect(success.headers.getSetCookie()).toHaveLength(2);
        expect(success.headers.getSetCookie()[0]).toContain('Max-Age=0');
        expect(success.headers.getSetCookie()[1]).toContain(
            'Path=/private; HttpOnly; SameSite=Lax; Secure; Max-Age=',
        );
        expect(success.headers.getSetCookie()[1]).not.toContain('Max-Age=7200');
        expect(success.headers.get('cache-control')).toBe('no-store');
        expect(fetcher).toHaveBeenCalledTimes(2);
        const invalid = await handler(request(callback, { cookie: cookie + '; ' + cookie }));
        expect(invalid.status).toBe(400);
        expect(invalid.headers.getSetCookie()).toEqual([]);
        expect(fetcher).toHaveBeenCalledTimes(2);
    });
    it.each(['/sso/start', '/sso/callback?state=invalid&code=secret'])(
        'does not mutate state during speculative navigation to %s',
        async (path) => {
            const fetcher = vi.fn<typeof fetch>();
            const response = await createBrowserSsoHttpHandler({ ...options, fetcher })(
                request(path, { 'sec-fetch-mode': 'cors' }),
            );
            expect(response.status).toBe(200);
            expect(response.headers.getSetCookie()).toEqual([]);
            expect(await response.text()).toContain('Continue in this browser tab');
            expect(fetcher).not.toHaveBeenCalled();
        },
    );
    it('uses legacy fallback only before state and only in auto mode', async () => {
        const fetcher = vi.fn<typeof fetch>(async () => new Response(null, { status: 404 }));
        const auto = await createBrowserSsoHttpHandler({ ...options, mode: 'auto', fetcher })(
            request('/sso/start?returnUrl=%2Fprivate&scope=reports'),
        );
        expect(auto.headers.get('location')).toContain('/login?');
        expect(
            new URL(auto.headers.get('location') ?? '', options.audience).searchParams.get('scope'),
        ).toBe('reports');
        expect(auto.headers.getSetCookie()).toEqual([]);
        const required = await createBrowserSsoHttpHandler({ ...options, fetcher })(
            request('/sso/start'),
        );
        expect(required.status).toBe(503);
        expect(required.headers.get('location')).toBeNull();
    });
    it('keeps callback public after opt-out and leaves existing app cookies untouched', async () => {
        const result = await createBrowserSsoHttpHandler({ ...options, mode: 'off' })(
            request('/sso/callback?state=x', { cookie: 'app-token=valid' }),
        );
        expect(result.status).toBe(400);
        expect(result.headers.getSetCookie()).toEqual([]);
        expect(await result.text()).toContain('Browser SSO is disabled');
    });
    it('shows explicit local/central sign-in controls without automatic redirects', async () => {
        const result = await createBrowserSsoHttpHandler(options)(request('/sso/signed-out'));
        expect(result.headers.get('location')).toBeNull();
        expect(await result.text()).toContain('End browser SSO session');
        expect(result.headers.getSetCookie()).toEqual([]);
    });
    it('rejects unsafe app cookies before consuming a code', () => {
        for (const cookieName of ['__Host-magic-sso-browser', 'magic-sso-tx-test', 'bad\r\nname']) {
            expect(() => createBrowserSsoHttpHandler({ ...options, cookieName })).toThrow();
        }
        expect(() =>
            createBrowserSsoHttpHandler({ ...options, cookiePath: '/; Domain=evil.test' }),
        ).toThrow();
    });
    it('validates opt-in mode instead of silently downgrading typos', () => {
        expect(parseBrowserSsoMode(undefined)).toBe('off');
        expect(parseBrowserSsoMode('auto')).toBe('auto');
        expect(() => parseBrowserSsoMode('requred')).toThrow();
    });
});
