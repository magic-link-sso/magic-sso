// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Wojciech Polak

import { NextRequest } from 'next/server';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { verifyEmailOtp } from './actions';
import { VerifyEmailOtpRoute } from './otpRoute';

vi.mock('./actions', () => ({
    verifyEmailOtp: vi.fn(),
}));

function createRequest(origin?: string, referer?: string): NextRequest {
    const formData = new FormData();
    formData.set('challengeId', 'challenge-1');
    formData.set('code', '012345');
    return new NextRequest('https://app.example.com/api/verify-email/otp', {
        method: 'POST',
        headers: {
            ...(typeof origin === 'string' ? { origin } : {}),
            ...(typeof referer === 'string' ? { referer } : {}),
        },
        body: formData,
    });
}

describe('VerifyEmailOtpRoute', () => {
    afterEach(() => {
        vi.mocked(verifyEmailOtp).mockReset();
    });

    it('rejects a cross-origin form before exchanging the OTP', async () => {
        const response = await VerifyEmailOtpRoute(createRequest('https://evil.example.com'));

        expect(response.status).toBe(403);
        expect(verifyEmailOtp).not.toHaveBeenCalled();
    });

    it('rejects a form with no Origin or Referer', async () => {
        const response = await VerifyEmailOtpRoute(createRequest());

        expect(response.status).toBe(403);
        expect(verifyEmailOtp).not.toHaveBeenCalled();
    });

    it('accepts a same-origin Referer and exchanges the OTP', async () => {
        vi.mocked(verifyEmailOtp).mockResolvedValue({ success: true });

        const response = await VerifyEmailOtpRoute(
            createRequest(undefined, 'https://app.example.com/login'),
        );

        expect(response.status).toBe(200);
        expect(verifyEmailOtp).toHaveBeenCalledWith('challenge-1', '012345');
    });
});
