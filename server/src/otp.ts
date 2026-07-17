/**
 * server/src/otp.ts
 *
 * Magic Link SSO Copyright (C) 2026 Wojciech Polak
 *
 * This program is free software; you can redistribute it and/or modify it
 * under the terms of the GNU General Public License as published by the
 * Free Software Foundation; either version 3 of the License, or (at your
 * option) any later version.
 */

import { createHmac, randomInt, timingSafeEqual } from 'node:crypto';

export function generateOtpCode(length: number): string {
    const upperBound = 10 ** length;
    return randomInt(upperBound).toString().padStart(length, '0');
}

export function normaliseOtpCode(value: string, length: number): string | null {
    const normalized = value.replace(/^[\t\n\r ]+|[\t\n\r ]+$/gu, '');
    return new RegExp(`^[0-9]{${length}}$`, 'u').test(normalized) ? normalized : null;
}

export function hashOtpCode(input: {
    challengeId: string;
    code: string;
    jti: string;
    secret: string;
    siteId: string;
}): string {
    return createHmac('sha256', input.secret)
        .update(input.challengeId)
        .update('\u0000')
        .update(input.code)
        .update('\u0000')
        .update(input.siteId)
        .update('\u0000')
        .update(input.jti)
        .digest('base64url');
}

export function createOtpRotationKey(input: {
    email: string;
    safeReturnUrl: string | undefined;
    safeVerifyUrl: string | undefined;
    scope: string;
    secret: string;
    siteId: string;
}): string {
    // The keyed digest keeps email addresses out of filenames and Redis keys.
    // Redirect bindings keep independent login contexts separate while a
    // resend of the same transaction invalidates its previous challenge.
    return createHmac('sha256', input.secret)
        .update(input.email.trim().toLowerCase())
        .update('\u0000')
        .update(input.siteId)
        .update('\u0000')
        .update(input.scope)
        .update('\u0000')
        .update(input.safeReturnUrl ?? '')
        .update('\u0000')
        .update(input.safeVerifyUrl ?? '')
        .digest('base64url');
}

export function isMatchingOtpHash(expected: string, submitted: string): boolean {
    const expectedBuffer = Buffer.from(expected, 'base64url');
    const submittedBuffer = Buffer.from(submitted, 'base64url');
    return (
        expectedBuffer.length === submittedBuffer.length &&
        timingSafeEqual(expectedBuffer, submittedBuffer)
    );
}
