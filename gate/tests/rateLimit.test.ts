// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Wojciech Polak

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
    createGateRateLimiter,
    createRedisGateRateLimiter,
    type RedisGateRateLimitClient,
} from '../src/rateLimit.js';

class FakeRedisGateRateLimitClient implements RedisGateRateLimitClient {
    private readonly attemptsByKey = new Map<string, number[]>();

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
        const attempts = (this.attemptsByKey.get(keyName) ?? []).filter(
            (attemptTimestampMs) => attemptTimestampMs > windowStartMs,
        );
        this.attemptsByKey.set(keyName, attempts);

        if (attempts.length >= limitMax) {
            return [0, attempts[0] ?? 0];
        }

        attempts.push(nowMs);
        attempts.sort((left, right) => left - right);
        this.attemptsByKey.set(keyName, attempts);
        return [1, 0];
    }

    async ping(): Promise<string> {
        return 'PONG';
    }

    async quit(): Promise<string> {
        return 'OK';
    }
}

describe('gate rate limiter', () => {
    beforeEach(() => {
        vi.useFakeTimers();
        vi.setSystemTime(new Date('2026-04-24T12:00:00Z'));
    });

    afterEach(() => {
        vi.useRealTimers();
    });

    it('limits repeated in-memory requests from the same key', async () => {
        const limiter = await createGateRateLimiter({
            keyPrefix: 'magic-sso-gate-test',
            max: 1,
            windowMs: 60_000,
        });

        await expect(limiter.consume('198.51.100.10')).resolves.toEqual({
            allowed: true,
            retryAfterSeconds: null,
        });
        await expect(limiter.consume('198.51.100.10')).resolves.toEqual({
            allowed: false,
            retryAfterSeconds: 60,
        });
    });

    it('shares Redis-backed limits across limiter instances', async () => {
        const client = new FakeRedisGateRateLimitClient();
        const firstLimiter = createRedisGateRateLimiter(
            {
                keyPrefix: 'magic-sso-gate-test',
                max: 1,
                windowMs: 60_000,
            },
            client,
        );
        const secondLimiter = createRedisGateRateLimiter(
            {
                keyPrefix: 'magic-sso-gate-test',
                max: 1,
                windowMs: 60_000,
            },
            client,
        );

        await expect(firstLimiter.consume('198.51.100.10')).resolves.toEqual({
            allowed: true,
            retryAfterSeconds: null,
        });
        await expect(secondLimiter.consume('198.51.100.10')).resolves.toEqual({
            allowed: false,
            retryAfterSeconds: 60,
        });
    });
});
