// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Wojciech Polak

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { readValidSignInBody, requestSignIn } from '../server/api/signin';

const magicSsoConfig = { serverUrl: 'http://localhost:3000' };
const requestOrigin = 'http://localhost:3002';
const fetchMock = vi.fn<typeof fetch>();
const validBody = {
    email: 'user@example.com',
    returnUrl: 'http://localhost:3002/protected',
    scope: ' reports ',
    verifyUrl: 'http://localhost:3002/verify-email',
};

describe('Nuxt sign-in flow', () => {
    beforeEach(() => {
        vi.stubGlobal('fetch', fetchMock);
    });

    afterEach(() => {
        vi.unstubAllGlobals();
        vi.unstubAllEnvs();
        fetchMock.mockReset();
    });

    it('accepts only complete sign-in payloads', () => {
        expect(readValidSignInBody(validBody)).toEqual(validBody);
        expect(readValidSignInBody({ email: 'user@example.com', returnUrl: '/' })).toBeNull();
        expect(readValidSignInBody(null)).toBeNull();
    });

    it('reports a missing or self-referencing server URL', async () => {
        vi.stubEnv('MAGICSSO_SERVER_URL', '');

        await expect(requestSignIn(validBody, { serverUrl: '' }, requestOrigin)).resolves.toEqual({
            success: false,
            message: 'MAGICSSO_SERVER_URL is not configured.',
        });

        vi.stubEnv('MAGICSSO_SERVER_URL', requestOrigin);
        await expect(requestSignIn(validBody, undefined, requestOrigin)).resolves.toMatchObject({
            success: false,
        });
        expect(fetchMock).not.toHaveBeenCalled();
    });

    it('sends the trimmed scope and returns OTP metadata', async () => {
        fetchMock.mockResolvedValue(
            Response.json({
                otpChallengeId: 'challenge-1',
                otpExpiresInSeconds: 300,
                otpLength: 6,
            }),
        );

        await expect(requestSignIn(validBody, magicSsoConfig, requestOrigin)).resolves.toEqual({
            success: true,
            message: 'Verification email sent.',
            otpChallengeId: 'challenge-1',
            otpExpiresInSeconds: 300,
            otpLength: 6,
        });
        const [url, init] = fetchMock.mock.calls[0] ?? [];
        expect(url).toBe('http://localhost:3000/signin');
        expect(JSON.parse(String(init?.body))).toMatchObject({ scope: 'reports' });
    });

    it('relays upstream failures and network errors', async () => {
        fetchMock.mockResolvedValueOnce(Response.json({ message: 'Blocked.' }, { status: 403 }));
        fetchMock.mockRejectedValueOnce(new Error('offline'));

        await expect(requestSignIn(validBody, magicSsoConfig, requestOrigin)).resolves.toEqual({
            success: false,
            message: 'Blocked.',
        });
        await expect(requestSignIn(validBody, magicSsoConfig, requestOrigin)).resolves.toEqual({
            success: false,
            message: 'offline',
        });
    });
});
