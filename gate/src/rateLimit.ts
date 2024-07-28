// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Wojciech Polak

import { createHash, randomUUID } from 'node:crypto';
import { Redis } from 'ioredis';

interface GateRateLimitConfig {
    keyPrefix: string;
    max: number;
    redisUrl?: string | undefined;
    windowMs: number;
}

interface GateRateLimitEntry {
    count: number;
    windowStartMs: number;
}

export interface GateRateLimitDecision {
    allowed: boolean;
    retryAfterSeconds: number | null;
}

export interface GateRateLimiter {
    close(): Promise<void>;
    consume(key: string): Promise<GateRateLimitDecision>;
}

export interface RedisGateRateLimitClient {
    connect(): Promise<void>;
    disconnect(): void;
    eval(script: string, numKeys: number, ...args: Array<number | string>): Promise<unknown>;
    ping(): Promise<string>;
    quit(): Promise<string>;
}

const RATE_LIMIT_SCRIPT = `
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

function assertPositiveInteger(value: number, name: string): void {
    if (!Number.isInteger(value) || value <= 0) {
        throw new Error(`${name} must be a positive integer.`);
    }
}

function pruneExpiredEntries(
    entries: Map<string, GateRateLimitEntry>,
    nowMs: number,
    windowMs: number,
): void {
    for (const [key, entry] of entries) {
        if (nowMs - entry.windowStartMs >= windowMs) {
            entries.delete(key);
        }
    }
}

function readRetryAfterSeconds(entry: GateRateLimitEntry, nowMs: number, windowMs: number): number {
    return Math.max(1, Math.ceil((entry.windowStartMs + windowMs - nowMs) / 1000));
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

function buildRateLimitKey(keyPrefix: string, key: string): string {
    const keyHash = createHash('sha256').update(key).digest('hex');
    return `${keyPrefix}:rate-limit:${keyHash}`;
}

function createRedisGateRateLimitClient(redisUrl: string): RedisGateRateLimitClient {
    return new Redis(redisUrl, {
        lazyConnect: true,
        maxRetriesPerRequest: 1,
    });
}

function createInMemoryGateRateLimiter(config: GateRateLimitConfig): GateRateLimiter {
    const entries = new Map<string, GateRateLimitEntry>();

    return {
        async close(): Promise<void> {
            entries.clear();
        },
        async consume(key: string): Promise<GateRateLimitDecision> {
            const nowMs = Date.now();
            pruneExpiredEntries(entries, nowMs, config.windowMs);

            const entry = entries.get(key);
            if (typeof entry === 'undefined') {
                entries.set(key, {
                    count: 1,
                    windowStartMs: nowMs,
                });
                return {
                    allowed: true,
                    retryAfterSeconds: null,
                };
            }

            if (nowMs - entry.windowStartMs >= config.windowMs) {
                entries.set(key, {
                    count: 1,
                    windowStartMs: nowMs,
                });
                return {
                    allowed: true,
                    retryAfterSeconds: null,
                };
            }

            if (entry.count < config.max) {
                entry.count += 1;
                return {
                    allowed: true,
                    retryAfterSeconds: null,
                };
            }

            return {
                allowed: false,
                retryAfterSeconds: readRetryAfterSeconds(entry, nowMs, config.windowMs),
            };
        },
    };
}

export function createRedisGateRateLimiter(
    config: GateRateLimitConfig,
    client: RedisGateRateLimitClient,
): GateRateLimiter {
    return {
        async close(): Promise<void> {
            await client.quit();
        },
        async consume(key: string): Promise<GateRateLimitDecision> {
            const nowMs = Date.now();
            const result = await client.eval(
                RATE_LIMIT_SCRIPT,
                1,
                buildRateLimitKey(config.keyPrefix, key),
                nowMs,
                nowMs - config.windowMs,
                config.max,
                config.windowMs,
                `${nowMs}-${randomUUID()}`,
            );

            if (!Array.isArray(result) || result.length < 2) {
                throw new Error('Redis returned an invalid gate rate limiter response.');
            }

            const allowed = readFiniteNumber(result[0], 'gate rate limiter allowed flag') === 1;
            if (allowed) {
                return {
                    allowed: true,
                    retryAfterSeconds: null,
                };
            }

            return {
                allowed: false,
                retryAfterSeconds: calculateRetryAfterSeconds(
                    readFiniteNumber(result[1], 'gate rate limiter retry timestamp'),
                    nowMs,
                    config.windowMs,
                ),
            };
        },
    };
}

export async function createGateRateLimiter(config: GateRateLimitConfig): Promise<GateRateLimiter> {
    assertPositiveInteger(config.max, 'Gate rate limit max');
    assertPositiveInteger(config.windowMs, 'Gate rate limit window');

    if (typeof config.redisUrl !== 'string') {
        return createInMemoryGateRateLimiter(config);
    }

    const client = createRedisGateRateLimitClient(config.redisUrl);
    try {
        await client.connect();
        await client.ping();
    } catch (error) {
        client.disconnect();
        throw error;
    }

    return createRedisGateRateLimiter(config, client);
}
