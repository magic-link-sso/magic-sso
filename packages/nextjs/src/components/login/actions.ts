/**
 * packages/nextjs/src/components/login/actions.ts
 *
 * @license MIT
 *
 * MIT License
 *
 * Magic Link SSO Copyright (C) 2026 Wojciech Polak
 *
 * Permission is hereby granted, free of charge, to any person obtaining a copy
 * of this software and associated documentation files (the "Software"), to deal
 * in the Software without restriction, including without limitation the rights
 * to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
 * copies of the Software, and to permit persons to whom the Software is
 * furnished to do so, subject to the following conditions:
 *
 * The above copyright notice and this permission notice shall be included in
 * all copies or substantial portions of the Software.
 *
 * THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
 * IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
 * FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
 * AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
 * LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
 * OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN
 * THE SOFTWARE.
 */

'use server';

import { cookies } from 'next/headers';
import { exchangeEmailOtp } from '@magic-link-sso/core';
import {
    buildAuthCookieOptions,
    getJwtSecret,
    getPublicOrigin,
    getServerIssuer,
} from '../../lib/auth';

export type SendMagicLinkResult =
    | {
          otpChallengeId?: string | undefined;
          otpExpiresInSeconds?: number | undefined;
          otpLength?: number | undefined;
          success: true;
      }
    | { message: string; success: false };

export type VerifyEmailOtpResult = { success: true } | { message: string; success: false };

interface ErrorMessageResponse {
    message?: string;
}

function readOtpMetadata(
    value: unknown,
): Omit<Extract<SendMagicLinkResult, { success: true }>, 'success'> {
    if (typeof value !== 'object' || value === null) {
        return {};
    }
    const challengeId = Reflect.get(value, 'otpChallengeId');
    const expiresInSeconds = Reflect.get(value, 'otpExpiresInSeconds');
    const length = Reflect.get(value, 'otpLength');
    return typeof challengeId === 'string' &&
        typeof expiresInSeconds === 'number' &&
        typeof length === 'number'
        ? {
              otpChallengeId: challengeId,
              otpExpiresInSeconds: expiresInSeconds,
              otpLength: length,
          }
        : {};
}

async function readErrorMessage(response: Response): Promise<string | undefined> {
    const data = (await response.json().catch(() => null)) as ErrorMessageResponse | null;
    if (typeof data?.message === 'string' && data.message.length > 0) {
        return data.message;
    }

    return undefined;
}

export async function sendMagicLink(
    email: string,
    returnUrl: string,
    scope?: string,
): Promise<SendMagicLinkResult> {
    const serverUrl = process.env.MAGICSSO_SERVER_URL;
    if (typeof serverUrl !== 'string' || serverUrl.length === 0) {
        return { success: false, message: 'MAGICSSO_SERVER_URL is not configured.' };
    }

    const normalizedScope = typeof scope === 'string' ? scope.trim() : '';

    try {
        const response = await fetch(new URL('/signin', serverUrl), {
            method: 'POST',
            headers: {
                'content-type': 'application/json',
            },
            body: JSON.stringify({
                email,
                returnUrl,
                ...(normalizedScope.length > 0 ? { scope: normalizedScope } : {}),
            }),
            cache: 'no-store',
        });
        if (!response.ok) {
            return {
                success: false,
                message: (await readErrorMessage(response)) ?? 'Failed to send verification email.',
            };
        }

        const payload: unknown = await response.json().catch(() => null);
        return { success: true, ...readOtpMetadata(payload) };
    } catch {
        return { success: false, message: 'Failed to send verification email.' };
    }
}

export async function verifyEmailOtp(
    challengeId: string,
    code: string,
): Promise<VerifyEmailOtpResult> {
    const serverUrl = process.env.MAGICSSO_SERVER_URL;
    const jwtSecret = getJwtSecret();
    const audience = getPublicOrigin();
    const issuer = getServerIssuer();
    if (
        typeof serverUrl !== 'string' ||
        serverUrl.length === 0 ||
        jwtSecret === null ||
        audience === null ||
        issuer === null
    ) {
        return { success: false, message: 'Magic Link SSO server configuration is incomplete.' };
    }
    try {
        const result = await exchangeEmailOtp({
            challengeId,
            code,
            expectedAudience: audience,
            expectedIssuer: issuer,
            fetcher: fetch,
            secret: jwtSecret,
            serverUrl,
        });
        if (result.kind !== 'success') {
            return { success: false, message: 'Invalid or expired code.' };
        }
        const cookieStore = await cookies();
        cookieStore.set(buildAuthCookieOptions(result.accessToken));
        return { success: true };
    } catch {
        return { success: false, message: 'Invalid or expired code.' };
    }
}
