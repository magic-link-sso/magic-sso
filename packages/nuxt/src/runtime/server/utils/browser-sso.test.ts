// SPDX-License-Identifier: MIT
import { afterEach, describe, expect, it, vi } from 'vitest';
import { resolveMagicSsoConfig, isPublicPath } from './auth';
import { createNuxtBrowserSsoHandler } from './browser-sso';
afterEach(() => vi.unstubAllGlobals());
describe('Nuxt browser SSO server adapter', () => {
    it('keeps infrastructure public with custom application exclusions and after opt-out', () => {
        for (const path of ['/sso/start', '/sso/callback', '/sso/signed-out']) {
            expect(isPublicPath(path, { excludedPaths: [] })).toBe(true);
        }
        expect(isPublicPath('/sso/callback/other', { excludedPaths: [] })).toBe(false);
    });
    it('requires trusted origin, rejects unsupported required SSO, and never falls back from callback', async () => {
        expect(() => createNuxtBrowserSsoHandler(resolveMagicSsoConfig())).toThrow();
        const config = resolveMagicSsoConfig({
            browserSsoMode: 'required',
            publicOrigin: 'https://nuxt.example.com',
            serverUrl: 'https://sso.example.com',
            jwtSecret: 'test-nuxt-browser-sso-secret-0123456789',
        });
        const fetcher = vi.fn(async () => new Response(null, { status: 404 }));
        vi.stubGlobal('fetch', fetcher);
        const handler = createNuxtBrowserSsoHandler(config);
        expect((await handler(new Request(config.publicOrigin + '/sso/start'))).status).toBe(503);
        const callback = await handler(
            new Request(config.publicOrigin + '/sso/callback?state=bad'),
        );
        expect(callback.status).toBe(400);
        expect(callback.headers.getSetCookie()).toEqual([]);
        expect(fetcher).toHaveBeenCalledTimes(1);
    });
});

it('passes application-owned form configuration through private Nuxt runtime options', async () => {
    vi.stubGlobal('fetch', async () =>
        Response.json({
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
        }),
    );
    const config = resolveMagicSsoConfig({
        browserSsoMode: 'required',
        browserSsoLoginUi: 'app-owned',
        publicOrigin: 'https://nuxt.example.com',
        serverUrl: 'https://sso.example.com',
        jwtSecret: 'test-nuxt-browser-sso-secret-0123456789',
    });
    const handler = createNuxtBrowserSsoHandler(config);
    const response = await handler(new Request(config.publicOrigin + '/sso/start'));
    expect(new URL(response.headers.get('location') ?? '').searchParams.get('loginUi')).toBe(
        'app-owned',
    );
});
