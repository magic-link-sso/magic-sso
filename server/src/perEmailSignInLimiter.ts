/**
 * server/src/perEmailSignInLimiter.ts
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
import { chmod, mkdir, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';

export interface SignInAttemptLimitResult {
    allowed: boolean;
    retryAfterSeconds: number;
}

export interface PerEmailSignInLimiter {
    consume(email: string, ip: string): Promise<SignInAttemptLimitResult>;
}

function normaliseAttemptKey(email: string): string {
    return email.trim().toLowerCase();
}

function buildKeyDirectoryPath(directory: string, email: string): string {
    const keyHash = createHash('sha256').update(normaliseAttemptKey(email)).digest('hex');
    return join(directory, keyHash);
}

function buildAttemptFilePath(directory: string, nowMs: number): string {
    return join(directory, `${nowMs}-${randomUUID()}.txt`);
}

async function readRecentAttempts(directory: string, windowStartMs: number): Promise<number[]> {
    const recentAttempts: number[] = [];
    const entries = await readdir(directory, { withFileTypes: true });

    for (const entry of entries) {
        if (!entry.isFile() || !entry.name.endsWith('.txt')) {
            continue;
        }

        const filePath = join(directory, entry.name);

        let contents: string;
        try {
            contents = await readFile(filePath, 'utf8');
        } catch (error) {
            if (error instanceof Error && 'code' in error && error.code === 'ENOENT') {
                continue;
            }

            throw error;
        }

        const attemptTimestampMs = Number.parseInt(contents.trim(), 10);
        if (Number.isFinite(attemptTimestampMs) && attemptTimestampMs > windowStartMs) {
            recentAttempts.push(attemptTimestampMs);
            continue;
        }

        await rm(filePath, { force: true });
    }

    recentAttempts.sort((left, right) => left - right);
    return recentAttempts;
}

function calculateRetryAfterSeconds(
    oldestAttemptMs: number | undefined,
    nowMs: number,
    windowMs: number,
): number {
    const retryAfterMs =
        typeof oldestAttemptMs === 'number' ? oldestAttemptMs + windowMs - nowMs : windowMs;
    return Math.ceil(Math.max(retryAfterMs, 1) / 1000);
}

export function createInMemoryPerEmailSignInLimiter(options: {
    rateLimitWindowMs: number;
    signInEmailRateLimitMax: number;
}): PerEmailSignInLimiter {
    process.emitWarning(
        'Using the in-memory per-email sign-in limiter does not survive process restarts. Prefer the default file-backed limiter or a persistent adapter in real deployments.',
        {
            code: 'MAGICSSO_IN_MEMORY_EMAIL_LIMITER',
        },
    );
    const attemptsByKey = new Map<string, number[]>();

    return {
        async consume(email: string, _ip: string): Promise<SignInAttemptLimitResult> {
            const nowMs = Date.now();
            const windowStart = nowMs - options.rateLimitWindowMs;
            const key = normaliseAttemptKey(email);
            const recentAttempts = (attemptsByKey.get(key) ?? []).filter(
                (timestampMs) => timestampMs > windowStart,
            );

            if (recentAttempts.length >= options.signInEmailRateLimitMax) {
                attemptsByKey.set(key, recentAttempts);
                return {
                    allowed: false,
                    retryAfterSeconds: calculateRetryAfterSeconds(
                        recentAttempts[0],
                        nowMs,
                        options.rateLimitWindowMs,
                    ),
                };
            }

            recentAttempts.push(nowMs);
            attemptsByKey.set(key, recentAttempts);
            return {
                allowed: true,
                retryAfterSeconds: 0,
            };
        },
    };
}

export async function createFilePerEmailSignInLimiter(options: {
    directory: string;
    rateLimitWindowMs: number;
    signInEmailRateLimitMax: number;
}): Promise<PerEmailSignInLimiter> {
    const directory = resolve(options.directory);
    await mkdir(directory, { mode: 0o700, recursive: true });
    await chmod(directory, 0o700);

    return {
        async consume(email: string, _ip: string): Promise<SignInAttemptLimitResult> {
            const nowMs = Date.now();
            const windowStartMs = nowMs - options.rateLimitWindowMs;
            // Limit by email instead of email+IP so rotating source addresses
            // cannot bypass the sign-in cap for a single inbox.
            const keyDirectory = buildKeyDirectoryPath(directory, email);
            await mkdir(keyDirectory, { mode: 0o700, recursive: true });
            await chmod(keyDirectory, 0o700);

            const recentAttempts = await readRecentAttempts(keyDirectory, windowStartMs);
            if (recentAttempts.length >= options.signInEmailRateLimitMax) {
                return {
                    allowed: false,
                    retryAfterSeconds: calculateRetryAfterSeconds(
                        recentAttempts[0],
                        nowMs,
                        options.rateLimitWindowMs,
                    ),
                };
            }

            await writeFile(buildAttemptFilePath(keyDirectory, nowMs), `${nowMs}\n`, {
                flag: 'wx',
                mode: 0o600,
            });
            return {
                allowed: true,
                retryAfterSeconds: 0,
            };
        },
    };
}
