// SPDX-License-Identifier: MIT
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
    buildLoginPath,
    buildLoginTarget,
    createBrowserSsoHandler,
    resolveMagicSsoConfig,
} from './lib/core';
const config = {
    browserSsoMode: 'required',
    serverUrl: 'https://sso.example.com',
    publicOrigin: 'https://app.example.com',
    jwtSecret: 'test-angular-browser-sso-secret-0123456789',
    directUse: true,
} as const; // Literal mode tests the public configuration type.
afterEach(() => vi.unstubAllGlobals());
describe('Angular SSR browser SSO', () => {
    it('routes both guard and public entry through app-owned SSO start when enabled', () => {
        for (const build of [buildLoginPath, buildLoginTarget]) {
            const url = new URL(
                build(config.publicOrigin, '/protected?x=1&x=2', config),
                config.publicOrigin,
            );
            expect(url.pathname).toBe('/sso/start');
            expect(url.searchParams.get('returnUrl')).toBe(
                config.publicOrigin + '/protected?x=1&x=2',
            );
        }
        expect(resolveMagicSsoConfig().browserSsoMode).toBe('off');
    });
    it('requires trusted public origin and fails closed on discovery failure', async () => {
        expect(() => createBrowserSsoHandler({ ...config, publicOrigin: '' })).toThrow();
        const fetcher = vi.fn(async () => new Response(null, { status: 503 }));
        vi.stubGlobal('fetch', fetcher);
        const handler = createBrowserSsoHandler(config);
        const result = await handler(new Request(config.publicOrigin + '/sso/start'));
        expect(result.status).toBe(503);
        expect(result.headers.getSetCookie()).toEqual([]);
        const callback = await handler(
            new Request(config.publicOrigin + '/sso/callback?state=bad'),
        );
        expect(callback.status).toBe(400);
        expect(fetcher).toHaveBeenCalledTimes(1);
    });
});

it('passes the selected application-owned UI through the Angular SSR handler', async () => {
    const fetcher = vi.fn(async () =>
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
    vi.stubGlobal('fetch', fetcher);
    const handler = createBrowserSsoHandler({ ...config, browserSsoLoginUi: 'app-owned' });
    const response = await handler(new Request(config.publicOrigin + '/sso/start'));
    expect(response.status).toBe(303);
    expect(new URL(response.headers.get('location') ?? '').searchParams.get('loginUi')).toBe(
        'app-owned',
    );
    expect(
        (
            await handler(
                new Request(config.publicOrigin + '/sso/start', {
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
