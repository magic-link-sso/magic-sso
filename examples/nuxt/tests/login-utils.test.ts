// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Wojciech Polak

import { describe, expect, it } from 'vitest';
import { buildLoginTarget, buildVerifyUrl, normaliseReturnUrl } from '../app/utils/login';

describe('Nuxt login utilities', () => {
    it('defaults the return url to the app origin', () => {
        expect(normaliseReturnUrl(undefined, 'http://localhost:3002')).toBe(
            'http://localhost:3002',
        );
    });

    it('converts relative return urls to absolute same-origin urls', () => {
        expect(normaliseReturnUrl('/protected', 'http://localhost:3002')).toBe(
            'http://localhost:3002/protected',
        );
    });

    it('falls back to the app origin for cross-origin return urls', () => {
        expect(normaliseReturnUrl('http://localhost:3001/protected', 'http://localhost:3002')).toBe(
            'http://localhost:3002',
        );
    });

    it('builds a verify callback url with the normalised return url', () => {
        expect(buildVerifyUrl('http://localhost:3002', 'http://localhost:3002/protected')).toBe(
            'http://localhost:3002/verify-email?returnUrl=http%3A%2F%2Flocalhost%3A3002%2Fprotected',
        );
    });

    it('builds a local login url when direct use is disabled', () => {
        expect(buildLoginTarget('http://localhost:3002', '/', false, 'http://localhost:3000')).toBe(
            '/login?returnUrl=http%3A%2F%2Flocalhost%3A3002%2F',
        );
    });

    it('builds a direct sso signin url when direct use is enabled', () => {
        const loginUrl = new URL(
            buildLoginTarget('http://localhost:3002', '/', true, 'http://localhost:3000'),
        );

        expect(loginUrl.origin).toBe('http://localhost:3000');
        expect(loginUrl.pathname).toBe('/signin');
        expect(loginUrl.searchParams.get('returnUrl')).toBe('http://localhost:3002/');
        expect(loginUrl.searchParams.get('verifyUrl')).toBe(
            'http://localhost:3002/verify-email?returnUrl=http%3A%2F%2Flocalhost%3A3002%2F',
        );
    });

    it('adds scope to local and direct login urls when provided', () => {
        expect(
            buildLoginTarget(
                'http://localhost:3002',
                '/',
                false,
                'http://localhost:3000',
                'album-A',
            ),
        ).toBe('/login?returnUrl=http%3A%2F%2Flocalhost%3A3002%2F&scope=album-A');
        const loginUrl = new URL(
            buildLoginTarget(
                'http://localhost:3002',
                '/',
                true,
                'http://localhost:3000',
                'album-A',
            ),
        );

        expect(loginUrl.origin).toBe('http://localhost:3000');
        expect(loginUrl.pathname).toBe('/signin');
        expect(loginUrl.searchParams.get('returnUrl')).toBe('http://localhost:3002/');
        expect(loginUrl.searchParams.get('scope')).toBe('album-A');
        expect(loginUrl.searchParams.get('verifyUrl')).toBe(
            'http://localhost:3002/verify-email?returnUrl=http%3A%2F%2Flocalhost%3A3002%2F',
        );
    });
});
