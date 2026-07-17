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
import {
    parseOtpChallenge,
    type OtpChallenge,
    type OtpChallengeStore,
    type OtpChallengeVerificationResult,
} from './otpChallengeStore.js';
import { hashOtpCode } from './otp.js';
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

const OTP_VERIFY_SCRIPT = `
-- otp_verify
local key = KEYS[1]
local active_key = KEYS[2]
local submitted_hash = ARGV[1]
local now_ms = tonumber(ARGV[2])
local payload = redis.call('GET', key)
if not payload then return {'not_found'} end
if redis.call('GET', active_key) ~= key then
    redis.call('DEL', key)
    return {'consumed'}
end
local challenge = cjson.decode(payload)
if tonumber(challenge.expiresAt) <= now_ms then
    redis.call('DEL', key)
    redis.call('DEL', active_key)
    return {'expired'}
end
if tonumber(challenge.attemptsRemaining) <= 0 then
    redis.call('DEL', key)
    redis.call('DEL', active_key)
    return {'too_many_attempts'}
end
if challenge.otpHash ~= submitted_hash then
    challenge.attemptsRemaining = tonumber(challenge.attemptsRemaining) - 1
    if challenge.attemptsRemaining <= 0 then
        redis.call('DEL', key)
        redis.call('DEL', active_key)
        return {'too_many_attempts'}
    end
    redis.call('SET', key, cjson.encode(challenge), 'PXAT', tonumber(challenge.expiresAt))
    return {'invalid'}
end
redis.call('DEL', key)
redis.call('DEL', active_key)
return {'valid', payload}
`;

const OTP_ROTATE_SCRIPT = `
-- otp_rotate
local challenge_key = KEYS[1]
local active_key = KEYS[2]
local payload = ARGV[1]
local expires_at = tonumber(ARGV[2])

if redis.call('EXISTS', challenge_key) == 1 then
    return {0}
end

local previous_challenge_key = redis.call('GET', active_key)
redis.call('SET', challenge_key, payload, 'PXAT', expires_at)
redis.call('SET', active_key, challenge_key, 'PXAT', expires_at)
if previous_challenge_key and previous_challenge_key ~= challenge_key then
    redis.call('DEL', previous_challenge_key)
end
return {1}
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

function buildOtpChallengeKey(keyPrefix: string, challengeId: string): string {
    return `${keyPrefix}:otp-challenge:${encodeURIComponent(challengeId)}`;
}

function buildOtpRotationKey(keyPrefix: string, rotationKey: string): string {
    return `${keyPrefix}:otp-active:${encodeURIComponent(rotationKey)}`;
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

export function createRedisOtpChallengeStore(options: {
    client: RedisSecurityStateClient;
    keyPrefix: string;
}): OtpChallengeStore {
    return {
        async create(challenge: OtpChallenge): Promise<void> {
            const result = await options.client.eval(
                OTP_ROTATE_SCRIPT,
                2,
                buildOtpChallengeKey(options.keyPrefix, challenge.challengeId),
                buildOtpRotationKey(options.keyPrefix, challenge.rotationKey),
                JSON.stringify(challenge),
                challenge.expiresAt,
            );
            if (!Array.isArray(result) || Number(result[0]) !== 1) {
                throw new Error('OTP challenge already exists.');
            }
        },
        async verify(input): Promise<OtpChallengeVerificationResult> {
            const key = buildOtpChallengeKey(options.keyPrefix, input.challengeId);
            const stored = await options.client.get(key);
            if (stored === null) {
                return { category: 'not_found' };
            }
            let storedChallenge: OtpChallenge | null;
            try {
                storedChallenge = parseOtpChallenge(JSON.parse(stored));
            } catch {
                return { category: 'store_error' };
            }
            if (storedChallenge === null) {
                return { category: 'store_error' };
            }
            const result = await options.client.eval(
                OTP_VERIFY_SCRIPT,
                2,
                key,
                buildOtpRotationKey(options.keyPrefix, storedChallenge.rotationKey),
                hashOtpCode({
                    challengeId: input.challengeId,
                    code: input.code,
                    jti: storedChallenge.jti,
                    secret: input.secret,
                    siteId: storedChallenge.siteId,
                }),
                input.now,
            );
            if (!Array.isArray(result) || typeof result[0] !== 'string') {
                return { category: 'store_error' };
            }

            const category = result[0];
            if (category === 'valid' && typeof result[1] === 'string') {
                try {
                    const challenge = parseOtpChallenge(JSON.parse(result[1]));
                    return challenge === null
                        ? { category: 'store_error' }
                        : { category: 'valid', challenge };
                } catch {
                    return { category: 'store_error' };
                }
            }
            if (
                category === 'expired' ||
                category === 'invalid' ||
                category === 'not_found' ||
                category === 'consumed' ||
                category === 'too_many_attempts'
            ) {
                return { category };
            }
            return { category: 'store_error' };
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
