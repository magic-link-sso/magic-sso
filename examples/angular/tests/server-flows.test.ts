// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Wojciech Polak

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
    exchangeOtpCode,
    exchangeVerificationToken,
    hasValidCsrfPair,
    isSameOriginMutation,
    previewVerificationToken,
    readSignInRequestBody,
    readVerifyOtpRequestBody,
    requestSignIn,
    selectVerifyToken,
    toWebHeaders,
} from '../src/server-flows';

const { exchangeEmailOtpMock, verifyAuthTokenMock } = vi.hoisted(() => ({
    exchangeEmailOtpMock: vi.fn(),
    verifyAuthTokenMock: vi.fn(),
}));

vi.mock('@magic-link-sso/angular', async (importOriginal) => ({
    ...(await importOriginal<typeof import('@magic-link-sso/angular')>()),
    exchangeEmailOtp: exchangeEmailOtpMock,
    verifyAuthToken: verifyAuthTokenMock,
}));

const appOrigin = 'http://localhost:3004';
const serverUrl = 'http://localhost:3000';
const fetchMock = vi.fn<typeof fetch>();

describe('Angular server request parsing', () => {
    it('keeps only non-empty string fields from request bodies', () => {
        expect(
            readSignInRequestBody({ email: 'user@example.com', scope: '', verifyUrl: 1 }),
        ).toEqual({
            email: 'user@example.com',
            returnUrl: undefined,
            scope: undefined,
            verifyUrl: undefined,
        });
        expect(readVerifyOtpRequestBody(null)).toEqual({
            challengeId: undefined,
            code: undefined,
            returnUrl: undefined,
        });
    });

    it('accepts mutations from this origin only', () => {
        expect(isSameOriginMutation(appOrigin, appOrigin, undefined)).toBe(true);
        expect(isSameOriginMutation(appOrigin, 'http://evil.example', `${appOrigin}/login`)).toBe(
            false,
        );
        expect(isSameOriginMutation(appOrigin, undefined, `${appOrigin}/login`)).toBe(true);
        expect(isSameOriginMutation(appOrigin, '', 'not a url')).toBe(false);
        expect(isSameOriginMutation(appOrigin, undefined, undefined)).toBe(false);
    });

    it('copies single and repeated headers', () => {
        const headers = toWebHeaders({
            accept: 'text/html',
            'x-list': ['a', 'b'],
            empty: undefined,
        });

        expect(headers.get('accept')).toBe('text/html');
        expect(headers.get('x-list')).toBe('a, b');
        expect(headers.has('empty')).toBe(false);
    });

    it('selects the verify token and validates the CSRF pair', () => {
        expect(selectVerifyToken(undefined, 'cookie')).toBe('cookie');
        expect(selectVerifyToken('posted', undefined)).toBe('posted');
        expect(selectVerifyToken('posted', 'posted')).toBe('posted');
        expect(selectVerifyToken('posted', 'cookie')).toBeUndefined();
        expect(hasValidCsrfPair('csrf', 'csrf')).toBe(true);
        expect(hasValidCsrfPair('csrf', 'other')).toBe(false);
        expect(hasValidCsrfPair(undefined, 'csrf')).toBe(false);
    });
});

describe('Angular server flows', () => {
    beforeEach(() => {
        fetchMock.mockReset();
        vi.stubGlobal('fetch', fetchMock);
    });

    afterEach(() => {
        vi.unstubAllGlobals();
        exchangeEmailOtpMock.mockReset();
        verifyAuthTokenMock.mockReset();
        delete process.env['MAGICSSO_JWT_SECRET'];
    });

    describe('requestSignIn', () => {
        const body = {
            email: 'user@example.com',
            returnUrl: `${appOrigin}/protected`,
            scope: ' album ',
            verifyUrl: `${appOrigin}/verify-email`,
        };

        it('rejects incomplete payloads and missing server configuration', async () => {
            await expect(
                requestSignIn({ email: 'user@example.com' }, appOrigin, serverUrl),
            ).resolves.toMatchObject({
                status: 400,
            });
            await expect(requestSignIn(body, appOrigin, undefined)).resolves.toEqual({
                result: { success: false, message: 'MAGICSSO_SERVER_URL is not configured.' },
                status: 500,
            });
            await expect(requestSignIn(body, appOrigin, appOrigin)).resolves.toMatchObject({
                status: 500,
            });
            expect(fetchMock).not.toHaveBeenCalled();
        });

        it('forwards the trimmed scope and returns OTP metadata', async () => {
            fetchMock.mockResolvedValue(
                Response.json({ otpChallengeId: 'challenge-1', otpLength: 6 }),
            );

            await expect(requestSignIn(body, appOrigin, serverUrl)).resolves.toEqual({
                result: {
                    message: 'Verification email sent.',
                    otpChallengeId: 'challenge-1',
                    otpLength: 6,
                    success: true,
                },
                status: 200,
            });
            const [, init] = fetchMock.mock.calls[0] ?? [];
            expect(JSON.parse(String(init?.body))).toMatchObject({ scope: 'album' });
        });

        it('relays server failures and network errors', async () => {
            fetchMock.mockResolvedValueOnce(
                Response.json({ message: 'Blocked.' }, { status: 403 }),
            );
            fetchMock.mockRejectedValueOnce(new Error('offline'));

            await expect(requestSignIn(body, appOrigin, serverUrl)).resolves.toEqual({
                result: { success: false, message: 'Blocked.' },
                status: 403,
            });
            await expect(requestSignIn(body, appOrigin, serverUrl)).resolves.toMatchObject({
                status: 502,
            });
        });
    });

    it('exchanges OTP codes only when the request is complete', async () => {
        exchangeEmailOtpMock.mockResolvedValueOnce({ accessToken: 'access-token' });
        exchangeEmailOtpMock.mockResolvedValueOnce(null);
        const otpBody = { challengeId: 'challenge-1', code: '123456' };

        await expect(exchangeOtpCode({ code: '123456' }, appOrigin, serverUrl)).resolves.toBeNull();
        await expect(exchangeOtpCode(otpBody, appOrigin, serverUrl)).resolves.toBe('access-token');
        await expect(exchangeOtpCode(otpBody, appOrigin, serverUrl)).resolves.toBeNull();
        expect(exchangeEmailOtpMock).toHaveBeenCalledTimes(2);
    });

    describe('previewVerificationToken', () => {
        const options = { previewSecret: 'preview-secret', serverUrl, token: 'email-token' };

        it('reports missing tokens and configuration', async () => {
            await expect(
                previewVerificationToken({ ...options, token: undefined }),
            ).resolves.toEqual({
                error: 'missing-verification-token',
            });
            await expect(
                previewVerificationToken({ ...options, previewSecret: undefined }),
            ).resolves.toEqual({ error: 'verify-email-misconfigured' });
        });

        it('returns the previewed email with the token', async () => {
            fetchMock.mockResolvedValue(Response.json({ email: 'user@example.com' }));

            await expect(previewVerificationToken(options)).resolves.toEqual({
                email: 'user@example.com',
                token: 'email-token',
            });
            const [url, init] = fetchMock.mock.calls[0] ?? [];
            expect(String(url)).toBe(`${serverUrl}/verify-email?token=email-token`);
            expect(new Headers(init?.headers).get('x-magic-sso-preview-secret')).toBe(
                'preview-secret',
            );
        });

        it('fails on rejected, malformed, or unreachable previews', async () => {
            fetchMock.mockResolvedValueOnce(new Response(null, { status: 400 }));
            fetchMock.mockResolvedValueOnce(Response.json({}));
            fetchMock.mockRejectedValueOnce(new Error('offline'));

            for (let attempt = 0; attempt < 3; attempt += 1) {
                await expect(previewVerificationToken(options)).resolves.toEqual({
                    error: 'verify-email-failed',
                });
            }
        });
    });

    describe('exchangeVerificationToken', () => {
        const options = { appOrigin, serverUrl, token: 'email-token' };

        it('returns the verified access token', async () => {
            process.env['MAGICSSO_JWT_SECRET'] = 'jwt-secret';
            fetchMock.mockResolvedValue(Response.json({ accessToken: 'access-token' }));
            verifyAuthTokenMock.mockResolvedValue({ email: 'user@example.com' });

            await expect(exchangeVerificationToken(options)).resolves.toEqual({
                accessToken: 'access-token',
            });
            expect(verifyAuthTokenMock).toHaveBeenCalledWith(
                'access-token',
                expect.any(Uint8Array),
                {
                    expectedAudience: appOrigin,
                    expectedIssuer: serverUrl,
                },
            );
        });

        it.each([
            {
                error: 'verify-email-misconfigured',
                prepare: (): typeof options => ({ ...options, serverUrl: '' }),
            },
            {
                error: 'verify-email-failed',
                prepare: (): typeof options => {
                    fetchMock.mockResolvedValue(new Response(null, { status: 400 }));
                    return options;
                },
            },
            {
                error: 'session-verification-misconfigured',
                prepare: (): typeof options => {
                    fetchMock.mockResolvedValue(Response.json({ accessToken: 'access-token' }));
                    return options;
                },
            },
            {
                error: 'session-verification-failed',
                prepare: (): typeof options => {
                    process.env['MAGICSSO_JWT_SECRET'] = 'jwt-secret';
                    fetchMock.mockResolvedValue(Response.json({ accessToken: 'access-token' }));
                    verifyAuthTokenMock.mockResolvedValue(null);
                    return options;
                },
            },
            {
                error: 'verify-email-failed',
                prepare: (): typeof options => {
                    fetchMock.mockRejectedValue(new Error('offline'));
                    return options;
                },
            },
        ])('reports $error', async ({ error, prepare }) => {
            await expect(exchangeVerificationToken(prepare())).resolves.toEqual({ error });
        });
    });
});
