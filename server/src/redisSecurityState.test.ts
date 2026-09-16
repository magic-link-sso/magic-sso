/**
 * server/src/redisSecurityState.test.ts
 *
 * Magic Link SSO Copyright (C) 2026 Wojciech Polak
 *
 * This program is free software; you can redistribute it and/or modify it
 * under the terms of the GNU General Public License as published by the
 * Free Software Foundation; either version 3 of the License, or (at your
 * option) any later version.
 *
 * This program is distributed in the hope that it will be useful,
 * but WITHOUT ANY WARRANTY; without even the implied warranty of
 * MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE. See the
 * GNU General Public License for more details.
 *
 * You should have received a copy of the GNU General Public License along
 * with this program. If not, see <https://www.gnu.org/licenses/>.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
    createRedisOtpChallengeStore,
    createRedisPerEmailSignInLimiter,
    createRedisSessionRevocationStore,
    createRedisVerificationTokenReplayStore,
    type RedisSecurityStateClient,
} from './redisSecurityState.js';
import { hashOtpCode } from './otp.js';
import { parseOtpChallenge, type OtpChallenge } from './otpChallengeStore.js';

function createOtpChallenge(overrides: Partial<OtpChallenge> = {}): OtpChallenge {
    const challengeId = overrides.challengeId ?? 'challenge-1';
    const jti = overrides.jti ?? 'grant-1';
    const siteId = overrides.siteId ?? 'site-1';
    return {
        attemptsRemaining: 3,
        challengeId,
        createdAt: Date.now(),
        email: 'user@example.com',
        expiresAt: Date.now() + 60_000,
        jti,
        otpHash: hashOtpCode({
            challengeId,
            code: '012345',
            jti,
            secret: 'otp-secret',
            siteId,
        }),
        rotationKey: 'rotation-1',
        safeReturnUrl: 'http://client.example.com/',
        safeVerifyUrl: 'http://client.example.com/verify-email',
        scope: '*',
        siteId,
        ...overrides,
    };
}

type OtpScriptArgs = [string, string, string, number | string | undefined];

function readOtpScriptArgs(
    numKeys: number,
    args: Array<number | string>,
    operation: 'rotation' | 'verification',
): OtpScriptArgs {
    if (numKeys !== 2) {
        throw new Error(`Expected exactly two Redis keys, received ${numKeys}.`);
    }
    const [challengeKey, activeKey, value, extra] = args;
    if (
        typeof challengeKey !== 'string' ||
        typeof activeKey !== 'string' ||
        typeof value !== 'string'
    ) {
        throw new Error(`Invalid OTP ${operation} arguments.`);
    }
    return [challengeKey, activeKey, value, extra];
}

class FakeRedisSecurityStateClient implements RedisSecurityStateClient {
    private readonly signInAttempts = new Map<string, number[]>();
    private readonly values = new Map<string, { expiresAt: number; value: string }>();

    private readValue(key: string): string | null {
        const stored = this.values.get(key);
        if (typeof stored === 'undefined') {
            return null;
        }
        if (stored.expiresAt <= Date.now()) {
            this.values.delete(key);
            return null;
        }
        return stored.value;
    }

    async connect(): Promise<void> {
        return undefined;
    }

    disconnect(): void {
        return undefined;
    }

    async eval(script: string, numKeys: number, ...args: Array<number | string>): Promise<unknown> {
        if (script.includes('-- otp_rotate')) {
            return this.evalOtpRotate(readOtpScriptArgs(numKeys, args, 'rotation'));
        }

        if (script.includes('-- otp_verify')) {
            return this.evalOtpVerify(readOtpScriptArgs(numKeys, args, 'verification'));
        }

        return this.evalSignInLimit(numKeys, args);
    }

    private evalOtpRotate([
        challengeKey,
        activeKey,
        payload,
        expiresAtValue,
    ]: OtpScriptArgs): unknown {
        if (this.readValue(challengeKey) !== null) {
            return [0];
        }
        const expiresAt = Number(expiresAtValue);
        const previousChallengeKey = this.readValue(activeKey);
        this.values.set(challengeKey, { expiresAt, value: payload });
        this.values.set(activeKey, { expiresAt, value: challengeKey });
        if (previousChallengeKey !== null && previousChallengeKey !== challengeKey) {
            this.values.delete(previousChallengeKey);
        }
        return [1];
    }

    private evalOtpVerify([
        challengeKey,
        activeKey,
        submittedHash,
        nowValue,
    ]: OtpScriptArgs): unknown {
        const payload = this.readValue(challengeKey);
        if (payload === null) {
            return ['not_found'];
        }
        if (this.readValue(activeKey) !== challengeKey) {
            this.values.delete(challengeKey);
            return ['consumed'];
        }
        const challenge = parseOtpChallenge(JSON.parse(payload));
        if (challenge === null) {
            throw new Error('Invalid stored OTP challenge.');
        }
        if (challenge.expiresAt <= Number(nowValue)) {
            this.deleteOtpKeys(challengeKey, activeKey);
            return ['expired'];
        }
        if (challenge.otpHash !== submittedHash) {
            return this.recordFailedOtpAttempt(challenge, challengeKey, activeKey);
        }
        this.deleteOtpKeys(challengeKey, activeKey);
        return ['valid', payload];
    }

    private recordFailedOtpAttempt(
        challenge: OtpChallenge,
        challengeKey: string,
        activeKey: string,
    ): unknown {
        challenge.attemptsRemaining -= 1;
        if (challenge.attemptsRemaining <= 0) {
            this.deleteOtpKeys(challengeKey, activeKey);
            return ['too_many_attempts'];
        }
        this.values.set(challengeKey, {
            expiresAt: challenge.expiresAt,
            value: JSON.stringify(challenge),
        });
        return ['invalid'];
    }

    private deleteOtpKeys(challengeKey: string, activeKey: string): void {
        this.values.delete(challengeKey);
        this.values.delete(activeKey);
    }

    private evalSignInLimit(numKeys: number, args: Array<number | string>): unknown {
        if (numKeys !== 1) {
            throw new Error(`Expected exactly one Redis key, received ${numKeys}.`);
        }

        const [key, nowMsValue, windowStartMsValue, limitMaxValue] = args;
        const keyName = typeof key === 'string' ? key : '';
        const windowStartMs = Number(windowStartMsValue);
        const attempts = (this.signInAttempts.get(keyName) ?? []).filter(
            (attemptTimestampMs) => attemptTimestampMs > windowStartMs,
        );
        this.signInAttempts.set(keyName, attempts);

        if (attempts.length >= Number(limitMaxValue)) {
            return [0, attempts[0] ?? 0];
        }

        attempts.push(Number(nowMsValue));
        attempts.sort((left, right) => left - right);
        this.signInAttempts.set(keyName, attempts);
        return [1, 0];
    }

    async ping(): Promise<string> {
        return 'PONG';
    }

    async get(key: string): Promise<string | null> {
        return this.readValue(key);
    }

    async quit(): Promise<string> {
        return 'OK';
    }

    async set(
        key: string,
        value: string,
        _mode: 'PXAT',
        expiresAt: number,
        _condition: 'NX',
    ): Promise<'OK' | null> {
        if (this.readValue(key) !== null) {
            return null;
        }

        this.values.set(key, { expiresAt, value });
        return 'OK';
    }
}

describe('createRedisOtpChallengeStore', () => {
    beforeEach(() => {
        vi.useFakeTimers();
        vi.setSystemTime(new Date('2026-04-13T12:30:00Z'));
    });

    afterEach(() => {
        vi.useRealTimers();
    });

    it('atomically invalidates the previous challenge for the same login transaction', async () => {
        const store = createRedisOtpChallengeStore({
            client: new FakeRedisSecurityStateClient(),
            keyPrefix: 'magic-sso-test',
        });
        const firstChallenge = createOtpChallenge();
        const secondChallenge = createOtpChallenge({
            challengeId: 'challenge-2',
            jti: 'grant-2',
        });
        await store.create(firstChallenge);
        await store.create(secondChallenge);

        await expect(
            store.verify({
                challengeId: firstChallenge.challengeId,
                code: '012345',
                now: Date.now(),
                secret: 'otp-secret',
            }),
        ).resolves.not.toMatchObject({ category: 'valid' });
        await expect(
            store.verify({
                challengeId: secondChallenge.challengeId,
                code: '012345',
                now: Date.now(),
                secret: 'otp-secret',
            }),
        ).resolves.toMatchObject({ category: 'valid' });
    });
});

describe('createRedisVerificationTokenReplayStore', () => {
    beforeEach(() => {
        vi.useFakeTimers();
        vi.setSystemTime(new Date('2026-04-13T12:30:00Z'));
    });

    afterEach(() => {
        vi.useRealTimers();
    });

    it('rejects replayed verification tokens across store instances', async () => {
        const client = new FakeRedisSecurityStateClient();
        const firstStore = createRedisVerificationTokenReplayStore({
            client,
            keyPrefix: 'magic-sso-test',
        });
        const secondStore = createRedisVerificationTokenReplayStore({
            client,
            keyPrefix: 'magic-sso-test',
        });

        await expect(firstStore.consume('token-jti', Date.now() + 60_000)).resolves.toBe(true);
        await expect(secondStore.consume('token-jti', Date.now() + 60_000)).resolves.toBe(false);
    });
});

describe('createRedisSessionRevocationStore', () => {
    beforeEach(() => {
        vi.useFakeTimers();
        vi.setSystemTime(new Date('2026-04-13T12:30:00Z'));
    });

    afterEach(() => {
        vi.useRealTimers();
    });

    it('shares revoked session state across store instances', async () => {
        const client = new FakeRedisSecurityStateClient();
        const firstStore = createRedisSessionRevocationStore({
            client,
            keyPrefix: 'magic-sso-test',
        });
        const secondStore = createRedisSessionRevocationStore({
            client,
            keyPrefix: 'magic-sso-test',
        });

        await firstStore.revoke('session-jti', Date.now() + 60_000);

        await expect(secondStore.isRevoked('session-jti')).resolves.toBe(true);
        await expect(secondStore.isRevoked('other-jti')).resolves.toBe(false);
    });
});

describe('createRedisPerEmailSignInLimiter', () => {
    beforeEach(() => {
        vi.useFakeTimers();
        vi.setSystemTime(new Date('2026-04-13T12:30:00Z'));
    });

    afterEach(() => {
        vi.useRealTimers();
    });

    it('applies the sign-in limit across limiter instances that share Redis state', async () => {
        const client = new FakeRedisSecurityStateClient();
        const firstLimiter = createRedisPerEmailSignInLimiter({
            client,
            keyPrefix: 'magic-sso-test',
            rateLimitWindowMs: 60_000,
            signInEmailRateLimitMax: 2,
        });
        const secondLimiter = createRedisPerEmailSignInLimiter({
            client,
            keyPrefix: 'magic-sso-test',
            rateLimitWindowMs: 60_000,
            signInEmailRateLimitMax: 2,
        });

        await expect(firstLimiter.consume('allowed@example.com', '127.0.0.1')).resolves.toEqual({
            allowed: true,
            retryAfterSeconds: 0,
        });
        await expect(secondLimiter.consume('allowed@example.com', '127.0.0.1')).resolves.toEqual({
            allowed: true,
            retryAfterSeconds: 0,
        });
        await expect(secondLimiter.consume('allowed@example.com', '127.0.0.1')).resolves.toEqual({
            allowed: false,
            retryAfterSeconds: 60,
        });
    });

    it('blocks repeated attempts for the same email even when the client IP changes', async () => {
        const client = new FakeRedisSecurityStateClient();
        const limiter = createRedisPerEmailSignInLimiter({
            client,
            keyPrefix: 'magic-sso-test',
            rateLimitWindowMs: 60_000,
            signInEmailRateLimitMax: 1,
        });

        await expect(limiter.consume('allowed@example.com', '127.0.0.1')).resolves.toEqual({
            allowed: true,
            retryAfterSeconds: 0,
        });
        await expect(limiter.consume('allowed@example.com', '127.0.0.2')).resolves.toEqual({
            allowed: false,
            retryAfterSeconds: 60,
        });
    });
});
