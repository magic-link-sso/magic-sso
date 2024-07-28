/**
 * server/src/redisSecurityState.ts
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

import { createHash, randomUUID } from 'node:crypto';
import { Redis } from 'ioredis';
import type { PerEmailSignInLimiter, SignInAttemptLimitResult } from './perEmailSignInLimiter.js';
import type { SessionRevocationStore } from './sessionRevocationStore.js';
import type { VerificationTokenReplayStore } from './verificationTokenReplayStore.js';

const SIGN_IN_LIMITER_SCRIPT = `
local key = KEYS[1]
local now_ms = tonumber(ARGV[1])
local window_start_ms = tonumber(ARGV[2])
local limit_max = tonumber(ARGV[3])
local window_ms = tonumber(ARGV[4])
local attempt_member = ARGV[5]

redis.call('ZREMRANGEBYSCORE', key, '-inf', window_start_ms)

local attempt_count = redis.call('ZCARD', key)
if attempt_count >= limit_max then
    local oldest_attempt = redis.call('ZRANGE', key, 0, 0, 'WITHSCORES')
    local oldest_attempt_ms = tonumber(oldest_attempt[2]) or 0
    return {0, oldest_attempt_ms}
end

redis.call('ZADD', key, now_ms, attempt_member)
redis.call('PEXPIRE', key, window_ms)
return {1, 0}
`;

export interface RedisSecurityStateClient {
    connect(): Promise<void>;
    disconnect(): void;
    eval(script: string, numKeys: number, ...args: Array<number | string>): Promise<unknown>;
    get(key: string): Promise<string | null>;
    ping(): Promise<string>;
    quit(): Promise<string>;
    set(
        key: string,
        value: string,
        mode: 'PXAT',
        expiresAt: number,
        condition: 'NX',
    ): Promise<'OK' | null>;
}

function buildReplayKey(keyPrefix: string, jti: string): string {
    return `${keyPrefix}:verification-replay:${encodeURIComponent(jti)}`;
}

function buildSessionRevocationKey(keyPrefix: string, jti: string): string {
    return `${keyPrefix}:session-revocation:${encodeURIComponent(jti)}`;
}

function normaliseAttemptKey(email: string): string {
    return email.trim().toLowerCase();
}

function buildSignInLimitKey(keyPrefix: string, email: string): string {
    const keyHash = createHash('sha256').update(normaliseAttemptKey(email)).digest('hex');
    return `${keyPrefix}:signin-email-limit:${keyHash}`;
}

function calculateRetryAfterSeconds(
    oldestAttemptMs: number,
    nowMs: number,
    windowMs: number,
): number {
    const retryAfterMs = oldestAttemptMs + windowMs - nowMs;
    return Math.ceil(Math.max(retryAfterMs, 1) / 1000);
}

function readFiniteNumber(value: unknown, fieldName: string): number {
    const numericValue =
        typeof value === 'number'
            ? value
            : typeof value === 'string'
              ? Number.parseInt(value, 10)
              : Number.NaN;

    if (!Number.isFinite(numericValue)) {
        throw new Error(`Redis returned an invalid ${fieldName} value.`);
    }

    return numericValue;
}

export function createRedisSecurityStateClient(redisUrl: string): RedisSecurityStateClient {
    return new Redis(redisUrl, {
        lazyConnect: true,
        maxRetriesPerRequest: 1,
    });
}

export function createRedisVerificationTokenReplayStore(options: {
    client: RedisSecurityStateClient;
    keyPrefix: string;
}): VerificationTokenReplayStore {
    return {
        async consume(jti: string, expiresAt: number): Promise<boolean> {
            // NX + PXAT keeps replay checks atomic across instances and lets Redis
            // expire the marker when the verification token would be invalid anyway.
            const result = await options.client.set(
                buildReplayKey(options.keyPrefix, jti),
                `${expiresAt}`,
                'PXAT',
                expiresAt,
                'NX',
            );
            return result === 'OK';
        },
    };
}

export function createRedisSessionRevocationStore(options: {
    client: RedisSecurityStateClient;
    keyPrefix: string;
}): SessionRevocationStore {
    return {
        async isRevoked(jti: string): Promise<boolean> {
            const value = await options.client.get(
                buildSessionRevocationKey(options.keyPrefix, jti),
            );
            return value !== null;
        },
        async revoke(jti: string, expiresAt: number): Promise<void> {
            await options.client.set(
                buildSessionRevocationKey(options.keyPrefix, jti),
                `${expiresAt}`,
                'PXAT',
                expiresAt,
                'NX',
            );
        },
    };
}

export function createRedisPerEmailSignInLimiter(options: {
    client: RedisSecurityStateClient;
    keyPrefix: string;
    rateLimitWindowMs: number;
    signInEmailRateLimitMax: number;
}): PerEmailSignInLimiter {
    return {
        async consume(email: string, _ip: string): Promise<SignInAttemptLimitResult> {
            const nowMs = Date.now();
            const result = await options.client.eval(
                SIGN_IN_LIMITER_SCRIPT,
                1,
                buildSignInLimitKey(options.keyPrefix, email),
                nowMs,
                nowMs - options.rateLimitWindowMs,
                options.signInEmailRateLimitMax,
                options.rateLimitWindowMs,
                `${nowMs}-${randomUUID()}`,
            );

            if (!Array.isArray(result) || result.length < 2) {
                throw new Error('Redis returned an invalid sign-in limiter response.');
            }

            const allowed = readFiniteNumber(result[0], 'sign-in limiter allowed flag') === 1;
            if (allowed) {
                return {
                    allowed: true,
                    retryAfterSeconds: 0,
                };
            }

            return {
                allowed: false,
                retryAfterSeconds: calculateRetryAfterSeconds(
                    readFiniteNumber(result[1], 'sign-in limiter retry timestamp'),
                    nowMs,
                    options.rateLimitWindowMs,
                ),
            };
        },
    };
}
