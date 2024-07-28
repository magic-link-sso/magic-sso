/**
 * server/src/perEmailSignInLimiter.test.ts
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

import { chmodSync, mkdtempSync, readdirSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
    createFilePerEmailSignInLimiter,
    createInMemoryPerEmailSignInLimiter,
} from './perEmailSignInLimiter.js';

function fileMode(path: string): number {
    return statSync(path).mode & 0o777;
}

describe('createFilePerEmailSignInLimiter', () => {
    let storeDir: string;

    beforeEach(() => {
        storeDir = mkdtempSync(join(tmpdir(), 'magic-sso-email-limit-'));
        vi.useFakeTimers();
        vi.setSystemTime(new Date('2026-04-09T12:30:00Z'));
    });

    afterEach(() => {
        vi.useRealTimers();
        rmSync(storeDir, { recursive: true, force: true });
    });

    it('allows attempts until the limit is reached', async () => {
        const limiter = await createFilePerEmailSignInLimiter({
            directory: storeDir,
            rateLimitWindowMs: 60_000,
            signInEmailRateLimitMax: 2,
        });

        await expect(limiter.consume('allowed@example.com', '127.0.0.1')).resolves.toEqual({
            allowed: true,
            retryAfterSeconds: 0,
        });
        await expect(limiter.consume('allowed@example.com', '127.0.0.1')).resolves.toEqual({
            allowed: true,
            retryAfterSeconds: 0,
        });
        await expect(limiter.consume('allowed@example.com', '127.0.0.1')).resolves.toEqual({
            allowed: false,
            retryAfterSeconds: 60,
        });
    });

    it('uses private permissions for the store directory and attempt files', async () => {
        chmodSync(storeDir, 0o755);
        const limiter = await createFilePerEmailSignInLimiter({
            directory: storeDir,
            rateLimitWindowMs: 60_000,
            signInEmailRateLimitMax: 2,
        });

        await expect(limiter.consume('allowed@example.com', '127.0.0.1')).resolves.toEqual({
            allowed: true,
            retryAfterSeconds: 0,
        });

        const [keyDirectoryName] = readdirSync(storeDir);
        if (typeof keyDirectoryName !== 'string') {
            throw new Error('Expected a per-email limiter key directory.');
        }

        const keyDirectory = join(storeDir, keyDirectoryName);
        const [attemptFileName] = readdirSync(keyDirectory);
        if (typeof attemptFileName !== 'string') {
            throw new Error('Expected a per-email limiter attempt file.');
        }

        expect(fileMode(storeDir)).toBe(0o700);
        expect(fileMode(keyDirectory)).toBe(0o700);
        expect(fileMode(join(keyDirectory, attemptFileName))).toBe(0o600);
    });

    it('persists attempts across limiter recreation', async () => {
        const firstLimiter = await createFilePerEmailSignInLimiter({
            directory: storeDir,
            rateLimitWindowMs: 60_000,
            signInEmailRateLimitMax: 1,
        });
        await expect(firstLimiter.consume('allowed@example.com', '127.0.0.1')).resolves.toEqual({
            allowed: true,
            retryAfterSeconds: 0,
        });

        const secondLimiter = await createFilePerEmailSignInLimiter({
            directory: storeDir,
            rateLimitWindowMs: 60_000,
            signInEmailRateLimitMax: 1,
        });
        await expect(secondLimiter.consume('allowed@example.com', '127.0.0.1')).resolves.toEqual({
            allowed: false,
            retryAfterSeconds: 60,
        });
    });

    it('drops expired attempts once the window has passed', async () => {
        const limiter = await createFilePerEmailSignInLimiter({
            directory: storeDir,
            rateLimitWindowMs: 60_000,
            signInEmailRateLimitMax: 1,
        });

        await expect(limiter.consume('allowed@example.com', '127.0.0.1')).resolves.toEqual({
            allowed: true,
            retryAfterSeconds: 0,
        });

        vi.advanceTimersByTime(61_000);

        await expect(limiter.consume('allowed@example.com', '127.0.0.1')).resolves.toEqual({
            allowed: true,
            retryAfterSeconds: 0,
        });
    });

    it('keeps limits isolated per email even when client IPs change', async () => {
        const limiter = await createFilePerEmailSignInLimiter({
            directory: storeDir,
            rateLimitWindowMs: 60_000,
            signInEmailRateLimitMax: 1,
        });

        await expect(limiter.consume('allowed@example.com', '127.0.0.1')).resolves.toEqual({
            allowed: true,
            retryAfterSeconds: 0,
        });
        await expect(limiter.consume('other@example.com', '127.0.0.1')).resolves.toEqual({
            allowed: true,
            retryAfterSeconds: 0,
        });
        await expect(limiter.consume('allowed@example.com', '127.0.0.2')).resolves.toEqual({
            allowed: false,
            retryAfterSeconds: 60,
        });
    });
});

describe('createInMemoryPerEmailSignInLimiter', () => {
    afterEach(() => {
        vi.restoreAllMocks();
    });

    it('warns that the in-memory limiter does not survive restarts', async () => {
        const emitWarningSpy = vi.spyOn(process, 'emitWarning').mockImplementation(() => undefined);
        const limiter = createInMemoryPerEmailSignInLimiter({
            rateLimitWindowMs: 60_000,
            signInEmailRateLimitMax: 1,
        });

        expect(emitWarningSpy).toHaveBeenCalledWith(
            'Using the in-memory per-email sign-in limiter does not survive process restarts. Prefer the default file-backed limiter or a persistent adapter in real deployments.',
            {
                code: 'MAGICSSO_IN_MEMORY_EMAIL_LIMITER',
            },
        );
        await expect(limiter.consume('allowed@example.com', '127.0.0.1')).resolves.toEqual({
            allowed: true,
            retryAfterSeconds: 0,
        });
        await expect(limiter.consume('allowed@example.com', '127.0.0.1')).resolves.toEqual({
            allowed: false,
            retryAfterSeconds: 60,
        });
    });
});
