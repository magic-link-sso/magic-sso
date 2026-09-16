// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Wojciech Polak

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { sendMagicLink, verifyEmailOtp } from './actions';

const cookieSet = vi.fn();

vi.mock('next/headers', () => ({
    cookies: async () => ({ set: cookieSet }),
}));

describe('sendMagicLink', () => {
    beforeEach(() => {
        vi.restoreAllMocks();
        process.env.MAGICSSO_SERVER_URL = 'http://sso.example.com';
    });

    it('posts the email and return url to the sso server', async () => {
        const fetchMock = vi.spyOn(globalThis, 'fetch').mockResolvedValue(
            new Response(null, {
                status: 200,
            }),
        );
        const consoleLogSpy = vi.spyOn(console, 'log').mockImplementation(() => undefined);
        const consoleErrorSpy = vi.spyOn(console, 'error').mockImplementation(() => undefined);

        try {
            const result = await sendMagicLink(
                'user@example.com',
                'http://app.example.com/protected',
            );

            expect(result).toEqual({ success: true });
            expect(fetchMock).toHaveBeenCalledWith(new URL('/signin', 'http://sso.example.com'), {
                method: 'POST',
                headers: {
                    'content-type': 'application/json',
                },
                body: JSON.stringify({
                    email: 'user@example.com',
                    returnUrl: 'http://app.example.com/protected',
                }),
                cache: 'no-store',
            });
            expect(consoleLogSpy).not.toHaveBeenCalled();
            expect(consoleErrorSpy).not.toHaveBeenCalled();
        } finally {
            consoleLogSpy.mockRestore();
            consoleErrorSpy.mockRestore();
        }
    });

    it('includes scope when provided', async () => {
        const fetchMock = vi.spyOn(globalThis, 'fetch').mockResolvedValue(
            new Response(null, {
                status: 200,
            }),
        );

        await expect(
            sendMagicLink('user@example.com', 'http://app.example.com/protected', 'album-A'),
        ).resolves.toEqual({ success: true });

        expect(fetchMock).toHaveBeenCalledWith(new URL('/signin', 'http://sso.example.com'), {
            method: 'POST',
            headers: {
                'content-type': 'application/json',
            },
            body: JSON.stringify({
                email: 'user@example.com',
                returnUrl: 'http://app.example.com/protected',
                scope: 'album-A',
            }),
            cache: 'no-store',
        });
    });

    it('returns OTP metadata without exposing an OTP code', async () => {
        vi.spyOn(globalThis, 'fetch').mockResolvedValue(
            new Response(
                JSON.stringify({
                    message: 'Verification email sent',
                    otpChallengeId: 'c4bc2a37-0190-4bd6-8dc6-bcf3186b0e74',
                    otpExpiresInSeconds: 300,
                    otpLength: 6,
                }),
                { status: 200, headers: { 'content-type': 'application/json' } },
            ),
        );

        await expect(
            sendMagicLink('user@example.com', 'http://app.example.com/protected'),
        ).resolves.toEqual({
            success: true,
            otpChallengeId: 'c4bc2a37-0190-4bd6-8dc6-bcf3186b0e74',
            otpExpiresInSeconds: 300,
            otpLength: 6,
        });
    });

    it('returns a generic failure without logging request details', async () => {
        vi.spyOn(globalThis, 'fetch').mockRejectedValue(new Error('network failed'));
        const consoleLogSpy = vi.spyOn(console, 'log').mockImplementation(() => undefined);
        const consoleErrorSpy = vi.spyOn(console, 'error').mockImplementation(() => undefined);

        try {
            const result = await sendMagicLink(
                'user@example.com',
                'http://app.example.com/protected',
            );

            expect(result).toEqual({
                success: false,
                message: 'Failed to send verification email.',
            });
            expect(consoleLogSpy).not.toHaveBeenCalled();
            expect(consoleErrorSpy).not.toHaveBeenCalled();
        } finally {
            consoleLogSpy.mockRestore();
            consoleErrorSpy.mockRestore();
        }
    });

    it('returns the server error message when the request fails with json', async () => {
        vi.spyOn(globalThis, 'fetch').mockResolvedValue(
            new Response(JSON.stringify({ message: 'Invalid or untrusted return URL' }), {
                status: 400,
                headers: {
                    'content-type': 'application/json',
                },
            }),
        );

        await expect(
            sendMagicLink('user@example.com', 'http://app.example.com/protected'),
        ).resolves.toEqual({
            success: false,
            message: 'Invalid or untrusted return URL',
        });
    });
});

describe('verifyEmailOtp', () => {
    beforeEach(() => {
        vi.restoreAllMocks();
        cookieSet.mockReset();
        process.env.MAGICSSO_SERVER_URL = 'http://sso.example.com';
        process.env.MAGICSSO_JWT_SECRET = 'jwt-secret-0123456789-0123456789';
        process.env.MAGICSSO_PUBLIC_ORIGIN = 'http://app.example.com';
    });

    afterEach(() => {
        delete process.env.MAGICSSO_JWT_SECRET;
        delete process.env.MAGICSSO_PUBLIC_ORIGIN;
    });

    it('reports incomplete server configuration without calling the server', async () => {
        const fetchMock = vi.spyOn(globalThis, 'fetch');
        delete process.env.MAGICSSO_PUBLIC_ORIGIN;

        await expect(verifyEmailOtp('challenge-1', '123456')).resolves.toEqual({
            success: false,
            message: 'Magic Link SSO server configuration is incomplete.',
        });
        expect(fetchMock).not.toHaveBeenCalled();
    });

    it('returns a generic failure when the code is rejected', async () => {
        vi.spyOn(globalThis, 'fetch').mockResolvedValue(
            Response.json({ message: 'Invalid code' }, { status: 400 }),
        );

        await expect(verifyEmailOtp('challenge-1', '000000')).resolves.toEqual({
            success: false,
            message: 'Invalid or expired code.',
        });
        expect(cookieSet).not.toHaveBeenCalled();
    });

    it('returns a generic failure when the server is unreachable', async () => {
        vi.spyOn(globalThis, 'fetch').mockRejectedValue(new Error('ECONNREFUSED'));

        await expect(verifyEmailOtp('challenge-1', '123456')).resolves.toEqual({
            success: false,
            message: 'Invalid or expired code.',
        });
    });
});
