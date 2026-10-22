// SPDX-License-Identifier: MIT
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createApp } from './app.js';
import { buildLoginTarget } from './auth.js';
afterEach(() => {
    vi.unstubAllEnvs();
    vi.unstubAllGlobals();
});
describe('Fastify browser SSO integration', () => {
    it('uses trusted app origin and exposes public callback and explicit signed-out routes', async () => {
        vi.stubEnv('MAGICSSO_BROWSER_SSO_MODE', 'required');
        vi.stubEnv('MAGICSSO_PUBLIC_ORIGIN', 'https://fastify.example.com');
        vi.stubEnv('MAGICSSO_SERVER_URL', 'https://sso.example.com');
        vi.stubEnv('MAGICSSO_JWT_SECRET', 'test-fastify-browser-sso-secret-0123456789');
        vi.stubEnv('MAGICSSO_DIRECT_USE', 'true');
        const fetcher = vi.fn<typeof fetch>(async () => new Response(null, { status: 404 }));
        vi.stubGlobal('fetch', fetcher);
        const app = await createApp({ logger: false });
        try {
            expect(
                new URL(
                    buildLoginTarget('https://fastify.example.com', '/protected'),
                    'https://fastify.example.com',
                ).pathname,
            ).toBe('/sso/start');
            const result = await app.inject({ url: '/sso/start', headers: { host: 'evil.test' } });
            expect(result.statusCode).toBe(503);
            expect(result.body).toContain('https://fastify.example.com/sso/start');
            const callback = await app.inject('/sso/callback?state=bad');
            expect(callback.statusCode).toBe(400);
            expect(callback.headers['set-cookie']).toBeUndefined();
            const signedOut = await app.inject('/sso/signed-out');
            expect(signedOut.body).toContain('End browser SSO session');
            const prefetch = await app.inject({
                url: '/sso/start',
                headers: { purpose: 'prefetch' },
            });
            expect(prefetch.statusCode).toBe(200);
            expect(fetcher).toHaveBeenCalledTimes(1);
        } finally {
            await app.close();
        }
    });
});
