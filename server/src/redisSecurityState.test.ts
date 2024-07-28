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
    createRedisPerEmailSignInLimiter,
    createRedisSessionRevocationStore,
    createRedisVerificationTokenReplayStore,
    type RedisSecurityStateClient,
} from './redisSecurityState.js';

class FakeRedisSecurityStateClient implements RedisSecurityStateClient {
    private readonly replayKeys = new Map<string, number>();
    private readonly signInAttempts = new Map<string, number[]>();

    async connect(): Promise<void> {
        return undefined;
    }

    disconnect(): void {
        return undefined;
    }

    async eval(
        _script: string,
        numKeys: number,
        ...args: Array<number | string>
    ): Promise<unknown> {
        if (numKeys !== 1) {
            throw new Error(`Expected exactly one Redis key, received ${numKeys}.`);
        }

        const [key, nowMsValue, windowStartMsValue, limitMaxValue] = args;
        const keyName = typeof key === 'string' ? key : '';
        const nowMs = Number(nowMsValue);
        const windowStartMs = Number(windowStartMsValue);
        const limitMax = Number(limitMaxValue);
        const attempts = (this.signInAttempts.get(keyName) ?? []).filter(
            (attemptTimestampMs) => attemptTimestampMs > windowStartMs,
        );
        this.signInAttempts.set(keyName, attempts);

        if (attempts.length >= limitMax) {
            return [0, attempts[0] ?? 0];
        }

        attempts.push(nowMs);
        attempts.sort((left, right) => left - right);
        this.signInAttempts.set(keyName, attempts);
        return [1, 0];
    }

    async ping(): Promise<string> {
        return 'PONG';
    }

    async get(key: string): Promise<string | null> {
        const expiresAt = this.replayKeys.get(key);
        if (typeof expiresAt !== 'number' || expiresAt <= Date.now()) {
            return null;
        }

        return `${expiresAt}`;
    }

    async quit(): Promise<string> {
        return 'OK';
    }

    async set(
        key: string,
        _value: string,
        _mode: 'PXAT',
        expiresAt: number,
        _condition: 'NX',
    ): Promise<'OK' | null> {
        const existingExpiresAt = this.replayKeys.get(key);
        if (typeof existingExpiresAt === 'number' && existingExpiresAt > Date.now()) {
            return null;
        }

        this.replayKeys.set(key, expiresAt);
        return 'OK';
    }
}

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
