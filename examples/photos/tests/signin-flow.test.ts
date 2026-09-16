// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Wojciech Polak

import { NextRequest } from 'next/server';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { POST } from '../src/app/api/signin/route';
import { buildLoginFormState, firstSearchParam, lookupMessage } from '../src/app/login/form-state';
import { readOtpMetadata, sendMagicLink } from '../src/app/login/signin';

vi.mock('@magic-link-sso/nextjs', async (importOriginal) => ({
    ...(await importOriginal<typeof import('@magic-link-sso/nextjs')>()),
    sendMagicLink: vi.fn(),
}));

const { sendMagicLink: requestMagicLink } = await import('@magic-link-sso/nextjs');

function createSignInRequest(fields: Record<string, string>, accept?: string): NextRequest {
    const formData = new FormData();
    for (const [name, value] of Object.entries(fields)) {
        formData.set(name, value);
    }
    return new NextRequest('http://localhost:5001/api/signin', {
        body: formData,
        headers: typeof accept === 'string' ? { accept } : {},
        method: 'POST',
    });
}

describe('Photos login form state', () => {
    it('reads the first repeated search parameter', () => {
        expect(firstSearchParam(['a', 'b'])).toBe('a');
        expect(firstSearchParam('a')).toBe('a');
        expect(firstSearchParam(undefined)).toBeUndefined();
    });

    it('looks up known status messages only', () => {
        const messages = { known: 'Known message' };

        expect(lookupMessage(messages, 'known')).toBe('Known message');
        expect(lookupMessage(messages, 'unknown')).toBeUndefined();
        expect(lookupMessage(messages, undefined)).toBeUndefined();
    });

    it('wires error feedback into the email field description', () => {
        expect(
            buildLoginFormState({
                appOrigin: 'http://localhost:5001',
                initialError: 'Try again.',
                returnUrl: '/albums/family',
            }),
        ).toEqual({
            emailDescribedBy: 'login-help login-feedback',
            feedbackId: 'login-feedback',
            hasError: true,
            hasSuccess: false,
            verifyUrl: 'http://localhost:5001/verify-email?returnUrl=%2Falbums%2Ffamily',
        });
        expect(
            buildLoginFormState({ appOrigin: 'http://localhost:5001', returnUrl: '/' }),
        ).toMatchObject({ emailDescribedBy: 'login-help', feedbackId: undefined });
    });
});

describe('Photos sign-in route', () => {
    beforeEach(() => {
        process.env.MAGICSSO_SERVER_URL = 'http://localhost:3000';
        process.env.MAGICSSO_PUBLIC_ORIGIN = 'http://localhost:5001';
        vi.spyOn(console, 'error').mockImplementation(() => undefined);
    });

    afterEach(() => {
        vi.mocked(requestMagicLink).mockReset();
        vi.restoreAllMocks();
        delete process.env.MAGICSSO_SERVER_URL;
        delete process.env.MAGICSSO_PUBLIC_ORIGIN;
    });

    it('rejects incomplete submissions', async () => {
        const redirect = await POST(createSignInRequest({ email: 'owner@example.com' }));
        const json = await POST(createSignInRequest({ verifyUrl: 'x' }, 'application/json'));

        expect(redirect.status).toBe(303);
        expect(redirect.headers.get('location')).toContain('error=invalid-signin-request');
        expect(json.status).toBe(400);
        await expect(json.json()).resolves.toMatchObject({ success: false });
        expect(requestMagicLink).not.toHaveBeenCalled();
    });

    it('returns OTP metadata as JSON after sending the email', async () => {
        vi.mocked(requestMagicLink).mockResolvedValue({
            otpChallengeId: 'challenge-1',
            otpLength: 6,
            success: true,
        });

        const response = await POST(
            createSignInRequest(
                {
                    email: 'owner@example.com',
                    returnUrl: '/albums/family',
                    scope: ' album:family ',
                    verifyUrl: 'http://localhost:5001/verify-email',
                },
                'application/json',
            ),
        );

        await expect(response.json()).resolves.toEqual({
            message: 'Verification email sent',
            otpChallengeId: 'challenge-1',
            otpLength: 6,
            success: true,
        });
        expect(requestMagicLink).toHaveBeenCalledWith(
            'owner@example.com',
            'http://localhost:5001/albums/family',
            'album:family',
            { verifyUrl: 'http://localhost:5001/verify-email' },
        );
    });

    it('redirects failures back to the login page with the scope', async () => {
        vi.mocked(requestMagicLink).mockResolvedValue({ message: 'Nope', success: false });

        const response = await POST(
            createSignInRequest({
                email: 'owner@example.com',
                scope: 'album:family',
                verifyUrl: 'http://localhost:5001/verify-email',
            }),
        );
        const location = new URL(response.headers.get('location') ?? '');

        expect(location.pathname).toBe('/login');
        expect(location.searchParams.get('error')).toBe('signin-request-failed');
        expect(location.searchParams.get('scope')).toBe('album:family');
    });

    it('reports a missing server URL as misconfiguration', async () => {
        delete process.env.MAGICSSO_SERVER_URL;

        await expect(
            sendMagicLink('owner@example.com', '/', 'http://localhost:5001/verify-email'),
        ).resolves.toMatchObject({ code: 'verify-email-misconfigured', success: false });
    });

    it('keeps OTP metadata only when both values are present', () => {
        expect(readOtpMetadata({ otpChallengeId: 'challenge-1' })).toEqual({});
        expect(readOtpMetadata({ otpChallengeId: 'challenge-1', otpLength: 8 })).toEqual({
            otpChallengeId: 'challenge-1',
            otpLength: 8,
        });
    });
});
