// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Wojciech Polak

import { NextRequest } from 'next/server';
import { afterEach, describe, expect, it } from 'vitest';
import { LogoutRoute } from './route';

function restoreEnv(name: string, value: string | undefined): void {
    if (typeof value === 'string') {
        process.env[name] = value;
        return;
    }

    delete process.env[name];
}

describe('LogoutRoute', () => {
    const originalCookieName = process.env.MAGICSSO_COOKIE_NAME;
    const originalCookiePath = process.env.MAGICSSO_COOKIE_PATH;
    const originalPublicOrigin = process.env.MAGICSSO_PUBLIC_ORIGIN;
    const originalTrustProxy = process.env.MAGICSSO_TRUST_PROXY;

    afterEach(() => {
        restoreEnv('MAGICSSO_COOKIE_NAME', originalCookieName);
        restoreEnv('MAGICSSO_COOKIE_PATH', originalCookiePath);
        restoreEnv('MAGICSSO_PUBLIC_ORIGIN', originalPublicOrigin);
        restoreEnv('MAGICSSO_TRUST_PROXY', originalTrustProxy);
    });

    it('clears the cookie with the configured path', async () => {
        process.env.MAGICSSO_COOKIE_NAME = 'magic-sso';
        process.env.MAGICSSO_COOKIE_PATH = '/auth';

        const response = await LogoutRoute(
            new NextRequest('http://app.example.com/logout', {
                method: 'POST',
                headers: {
                    origin: 'http://app.example.com',
                },
            }),
        );
        const cookie = response.cookies.get('magic-sso');

        expect(cookie?.path).toBe('/auth');
        expect(cookie?.value).toBe('');
        expect(cookie?.sameSite).toBe('lax');
    });

    it('rejects non-POST requests', async () => {
        const response = await LogoutRoute(new NextRequest('http://app.example.com/logout'));

        expect(response.status).toBe(405);
        expect(response.headers.get('allow')).toBe('POST');
    });

    it('rejects cross-origin POST requests', async () => {
        const response = await LogoutRoute(
            new NextRequest('http://app.example.com/logout', {
                method: 'POST',
                headers: {
                    origin: 'https://evil.example.com',
                },
            }),
        );

        expect(response.status).toBe(403);
        expect(response.cookies.getAll()).toHaveLength(0);
    });

    it('accepts proxied same-origin POST requests when a public origin is configured', async () => {
        process.env.MAGICSSO_PUBLIC_ORIGIN = 'http://photos.localhost:4306';

        const response = await LogoutRoute(
            new NextRequest('http://0.0.0.0:5001/logout', {
                method: 'POST',
                headers: {
                    origin: 'http://photos.localhost:4306',
                    host: '0.0.0.0:5001',
                },
            }),
        );

        expect(response.status).toBe(303);
        expect(response.headers.get('location')).toBe('http://photos.localhost:4306/');
    });

    it('accepts proxied same-origin POST requests when trust proxy is enabled', async () => {
        process.env.MAGICSSO_TRUST_PROXY = 'true';

        const response = await LogoutRoute(
            new NextRequest('http://0.0.0.0:5001/logout', {
                method: 'POST',
                headers: {
                    origin: 'http://photos.localhost:4306',
                    host: '0.0.0.0:5001',
                    'x-forwarded-host': 'photos.localhost:4306',
                    'x-forwarded-proto': 'http',
                },
            }),
        );

        expect(response.status).toBe(303);
        expect(response.headers.get('location')).toBe('http://photos.localhost:4306/');
    });
});
