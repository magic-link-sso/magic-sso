// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Wojciech Polak

import { beforeEach, describe, expect, it } from 'vitest';
import {
    buildLoginTarget,
    buildVerifyUrl,
    getLoginErrorMessage,
    normaliseReturnUrl,
} from '../src/app/login-utils';

describe('Angular login utilities', () => {
    beforeEach(() => {
        delete process.env['MAGICSSO_DIRECT_USE'];
        delete process.env['MAGICSSO_SERVER_URL'];
    });

    it('defaults the return url to the app origin', () => {
        expect(normaliseReturnUrl(undefined, 'http://localhost:3004')).toBe(
            'http://localhost:3004',
        );
    });

    it('converts relative return urls to absolute same-origin urls', () => {
        expect(normaliseReturnUrl('/protected', 'http://localhost:3004')).toBe(
            'http://localhost:3004/protected',
        );
    });

    it('falls back to the app origin for cross-origin return urls', () => {
        expect(normaliseReturnUrl('http://localhost:3001/protected', 'http://localhost:3004')).toBe(
            'http://localhost:3004',
        );
    });

    it('builds a verify callback url with the normalised return url', () => {
        expect(buildVerifyUrl('http://localhost:3004', 'http://localhost:3004/protected')).toBe(
            'http://localhost:3004/verify-email?returnUrl=http%3A%2F%2Flocalhost%3A3004%2Fprotected',
        );
    });

    it('builds a local login url for the home page', () => {
        expect(buildLoginTarget('http://localhost:3004')).toBe(
            '/login?returnUrl=http%3A%2F%2Flocalhost%3A3004%2F',
        );
    });

    it('adds scope to the local login url when provided', () => {
        expect(buildLoginTarget('http://localhost:3004', 'album-A')).toBe(
            '/login?returnUrl=http%3A%2F%2Flocalhost%3A3004%2F&scope=album-A',
        );
    });

    it('supports an explicit return target for local login urls', () => {
        expect(buildLoginTarget('http://localhost:3004', '/protected')).toBe(
            '/login?returnUrl=http%3A%2F%2Flocalhost%3A3004%2Fprotected',
        );
    });

    it('builds a hosted sign-in url when direct use is enabled', () => {
        process.env['MAGICSSO_DIRECT_USE'] = 'true';
        process.env['MAGICSSO_SERVER_URL'] = 'http://localhost:3000';

        const loginUrl = new URL(
            buildLoginTarget('http://localhost:3004', '/protected', 'album-A'),
        );

        expect(loginUrl.origin).toBe('http://localhost:3000');
        expect(loginUrl.pathname).toBe('/signin');
        expect(loginUrl.searchParams.get('returnUrl')).toBe('http://localhost:3004/protected');
        expect(loginUrl.searchParams.get('scope')).toBe('album-A');
        expect(loginUrl.searchParams.get('verifyUrl')).toBe(
            'http://localhost:3004/verify-email?returnUrl=http%3A%2F%2Flocalhost%3A3004%2Fprotected',
        );
    });

    it('maps known login error codes to user-facing messages', () => {
        expect(getLoginErrorMessage('verify-email-failed')).toBe(
            'We could not complete sign-in from that email link. Please request a new one.',
        );
        expect(getLoginErrorMessage('unknown')).toBeUndefined();
    });
});
