import { describe, expect, it } from 'vitest';
import {
    createOtpRotationKey,
    generateOtpCode,
    hashOtpCode,
    isMatchingOtpHash,
    normaliseOtpCode,
} from './otp.js';

describe('OTP helpers', () => {
    it('generates an exactly-sized numeric code', () => {
        const code = generateOtpCode(6);

        expect(code).toMatch(/^[0-9]{6}$/u);
    });

    it('only normalises ASCII edge whitespace around a complete numeric code', () => {
        expect(normaliseOtpCode(' \t012345\r\n', 6)).toBe('012345');
        expect(normaliseOtpCode('012 345', 6)).toBeNull();
        expect(normaliseOtpCode('012-345', 6)).toBeNull();
        expect(normaliseOtpCode('１２３４５６', 6)).toBeNull();
    });

    it('binds OTP hashes to the challenge, site, and verification grant', () => {
        const input = {
            challengeId: 'challenge-1',
            code: '012345',
            jti: 'grant-1',
            secret: 'otp-secret',
            siteId: 'site-a',
        };
        const hash = hashOtpCode(input);

        expect(isMatchingOtpHash(hash, hashOtpCode(input))).toBe(true);
        expect(isMatchingOtpHash(hash, hashOtpCode({ ...input, jti: 'grant-2' }))).toBe(false);
    });

    it('uses one opaque rotation scope for equivalent login transactions', () => {
        const input = {
            email: ' User@Example.com ',
            safeReturnUrl: 'https://app.example.com/protected',
            safeVerifyUrl: 'https://app.example.com/verify-email',
            scope: 'album-a',
            secret: 'otp-secret',
            siteId: 'site-a',
        };
        const rotationKey = createOtpRotationKey(input);

        expect(rotationKey).toMatch(/^[A-Za-z0-9_-]{43}$/u);
        expect(createOtpRotationKey({ ...input, email: 'user@example.com' })).toBe(rotationKey);
        expect(createOtpRotationKey({ ...input, scope: 'album-b' })).not.toBe(rotationKey);
    });
});
