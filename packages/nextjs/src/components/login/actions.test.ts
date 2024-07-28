// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Wojciech Polak

import { beforeEach, describe, expect, it, vi } from 'vitest';
import { sendMagicLink } from './actions';

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
