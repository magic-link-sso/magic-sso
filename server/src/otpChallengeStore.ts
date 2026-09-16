/**
 * server/src/otpChallengeStore.ts
 *
 * Magic Link SSO Copyright (C) 2026 Wojciech Polak
 *
 * This program is free software; you can redistribute it and/or modify it
 * under the terms of the GNU General Public License as published by the
 * Free Software Foundation; either version 3 of the License, or (at your
 * option) any later version.
 */

import { randomUUID } from 'node:crypto';
import {
    chmod,
    mkdir,
    open,
    readdir,
    readFile,
    rename,
    rm,
    stat,
    writeFile,
} from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { hashOtpCode, isMatchingOtpHash } from './otp.js';

export interface OtpChallenge {
    attemptsRemaining: number;
    challengeId: string;
    createdAt: number;
    email: string;
    expiresAt: number;
    jti: string;
    otpHash: string;
    rotationKey: string;
    safeReturnUrl: string | undefined;
    safeVerifyUrl?: string | undefined;
    scope: string;
    siteId: string;
}

export type OtpChallengeVerificationResult =
    | { category: 'valid'; challenge: OtpChallenge }
    | {
          category:
              | 'consumed'
              | 'expired'
              | 'invalid'
              | 'not_found'
              | 'store_error'
              | 'too_many_attempts';
      };

export interface OtpChallengeStore {
    create(challenge: OtpChallenge): Promise<void>;
    verify(input: {
        challengeId: string;
        code: string;
        now: number;
        secret: string;
    }): Promise<OtpChallengeVerificationResult>;
}

function challengeFileName(challengeId: string): string {
    return `${encodeURIComponent(challengeId)}.json`;
}

function challengePath(directory: string, challengeId: string): string {
    return join(directory, challengeFileName(challengeId));
}

function lockPath(directory: string, challengeId: string): string {
    return join(directory, `${encodeURIComponent(challengeId)}.lock`);
}

function rotationPointerPath(directory: string, rotationKey: string): string {
    return join(directory, `${encodeURIComponent(rotationKey)}.active`);
}

export function parseOtpChallenge(value: unknown): OtpChallenge | null {
    if (typeof value !== 'object' || value === null) {
        return null;
    }

    const fields = [
        'attemptsRemaining',
        'challengeId',
        'createdAt',
        'email',
        'expiresAt',
        'jti',
        'otpHash',
        'rotationKey',
        'scope',
        'siteId',
    ] as const;
    if (fields.some((field) => typeof Reflect.get(value, field) === 'undefined')) {
        return null;
    }

    const read = (field: string): unknown => Reflect.get(value, field);
    const isValid =
        typeof read('attemptsRemaining') === 'number' &&
        typeof read('challengeId') === 'string' &&
        typeof read('createdAt') === 'number' &&
        typeof read('email') === 'string' &&
        typeof read('expiresAt') === 'number' &&
        typeof read('jti') === 'string' &&
        typeof read('otpHash') === 'string' &&
        typeof read('rotationKey') === 'string' &&
        (typeof read('safeReturnUrl') === 'string' ||
            typeof read('safeReturnUrl') === 'undefined') &&
        (typeof read('safeVerifyUrl') === 'string' ||
            typeof read('safeVerifyUrl') === 'undefined') &&
        typeof read('scope') === 'string' &&
        typeof read('siteId') === 'string';
    return isValid ? (value as OtpChallenge) : null; // Validated field-by-field immediately above.
}

async function pause(milliseconds: number): Promise<void> {
    await new Promise<void>((resolvePromise) => {
        setTimeout(resolvePromise, milliseconds);
    });
}

function hasErrorCode(error: unknown, code: string): boolean {
    return error instanceof Error && 'code' in error && error.code === code;
}

async function tryCreateLockFile(path: string): Promise<boolean> {
    try {
        const handle = await open(path, 'wx', 0o600);
        await handle.close();
        return true;
    } catch (error) {
        if (!hasErrorCode(error, 'EEXIST')) {
            throw error;
        }
        return false;
    }
}

async function removeStaleLockFile(path: string): Promise<void> {
    try {
        const lockInfo = await stat(path);
        if (Date.now() - lockInfo.mtimeMs > 10_000) {
            await rm(path, { force: true });
        }
    } catch (error) {
        if (!hasErrorCode(error, 'ENOENT')) {
            throw error;
        }
    }
}

async function withFileLock<T>(
    directory: string,
    challengeId: string,
    callback: () => Promise<T>,
): Promise<T> {
    const path = lockPath(directory, challengeId);
    for (let attempt = 0; attempt < 100; attempt += 1) {
        if (await tryCreateLockFile(path)) {
            try {
                return await callback();
            } finally {
                await rm(path, { force: true });
            }
        }

        await removeStaleLockFile(path);
        await pause(5);
    }

    throw new Error('Timed out waiting for OTP challenge file lock.');
}

async function readChallenge(path: string): Promise<OtpChallenge | null> {
    try {
        const parsed: unknown = JSON.parse(await readFile(path, 'utf8'));
        return parseOtpChallenge(parsed);
    } catch (error) {
        if (hasErrorCode(error, 'ENOENT')) {
            return null;
        }
        throw error;
    }
}

async function readActiveChallengeId(
    directory: string,
    rotationKey: string,
): Promise<string | null> {
    try {
        const challengeId = await readFile(rotationPointerPath(directory, rotationKey), 'utf8');
        return challengeId.length > 0 ? challengeId : null;
    } catch (error) {
        if (hasErrorCode(error, 'ENOENT')) {
            return null;
        }
        throw error;
    }
}

async function replaceActiveChallengeId(
    directory: string,
    rotationKey: string,
    challengeId: string,
): Promise<void> {
    const path = rotationPointerPath(directory, rotationKey);
    const temporaryPath = `${path}.${randomUUID()}.tmp`;
    try {
        await writeFile(temporaryPath, challengeId, {
            encoding: 'utf8',
            flag: 'wx',
            mode: 0o600,
        });
        await rename(temporaryPath, path);
    } finally {
        await rm(temporaryPath, { force: true });
    }
}

async function removeChallengeAndPointer(
    directory: string,
    challenge: OtpChallenge,
): Promise<void> {
    await rm(challengePath(directory, challenge.challengeId), { force: true });
    if ((await readActiveChallengeId(directory, challenge.rotationKey)) === challenge.challengeId) {
        await rm(rotationPointerPath(directory, challenge.rotationKey), { force: true });
    }
}

async function pruneExpiredChallenges(directory: string, now: number): Promise<void> {
    const entries = await readdir(directory, { withFileTypes: true });
    await Promise.all(
        entries
            .filter((entry) => entry.isFile() && entry.name.endsWith('.json'))
            .map(async (entry): Promise<void> => {
                const path = join(directory, entry.name);
                const challenge = await readChallenge(path);
                if (challenge === null) {
                    await rm(path, { force: true });
                    return;
                }
                if (challenge.expiresAt <= now) {
                    await withFileLock(
                        directory,
                        `rotation:${challenge.rotationKey}`,
                        async (): Promise<void> => {
                            const currentChallenge = await readChallenge(path);
                            if (currentChallenge !== null && currentChallenge.expiresAt <= now) {
                                await removeChallengeAndPointer(directory, currentChallenge);
                            }
                        },
                    );
                }
            }),
    );
}

export async function createFileOtpChallengeStore(options: {
    directory: string;
    pruneIntervalMs?: number;
}): Promise<OtpChallengeStore> {
    const directory = resolve(options.directory);
    const pruneIntervalMs = options.pruneIntervalMs ?? 60_000;
    let nextPruneAt = 0;
    await mkdir(directory, { mode: 0o700, recursive: true });
    await chmod(directory, 0o700);

    return {
        async create(challenge: OtpChallenge): Promise<void> {
            const now = Date.now();
            if (now >= nextPruneAt) {
                await pruneExpiredChallenges(directory, now);
                nextPruneAt = now + pruneIntervalMs;
            }
            await withFileLock(
                directory,
                `rotation:${challenge.rotationKey}`,
                async (): Promise<void> => {
                    const previousChallengeId = await readActiveChallengeId(
                        directory,
                        challenge.rotationKey,
                    );
                    const path = challengePath(directory, challenge.challengeId);
                    await writeFile(path, JSON.stringify(challenge), {
                        encoding: 'utf8',
                        flag: 'wx',
                        mode: 0o600,
                    });
                    try {
                        await replaceActiveChallengeId(
                            directory,
                            challenge.rotationKey,
                            challenge.challengeId,
                        );
                    } catch (error) {
                        await rm(path, { force: true });
                        throw error;
                    }
                    if (
                        previousChallengeId !== null &&
                        previousChallengeId !== challenge.challengeId
                    ) {
                        await rm(challengePath(directory, previousChallengeId), { force: true });
                    }
                },
            );
        },
        async verify(input): Promise<OtpChallengeVerificationResult> {
            const initialChallenge = await readChallenge(
                challengePath(directory, input.challengeId),
            );
            if (initialChallenge === null) {
                return { category: 'not_found' };
            }
            return withFileLock(
                directory,
                `rotation:${initialChallenge.rotationKey}`,
                async (): Promise<OtpChallengeVerificationResult> => {
                    const path = challengePath(directory, input.challengeId);
                    const challenge = await readChallenge(path);
                    if (challenge === null) {
                        return { category: 'not_found' };
                    }
                    const activeChallengeId = await readActiveChallengeId(
                        directory,
                        challenge.rotationKey,
                    );
                    if (activeChallengeId !== challenge.challengeId) {
                        await rm(path, { force: true });
                        return { category: 'consumed' };
                    }
                    if (challenge.expiresAt <= input.now) {
                        await removeChallengeAndPointer(directory, challenge);
                        return { category: 'expired' };
                    }
                    if (challenge.attemptsRemaining <= 0) {
                        await removeChallengeAndPointer(directory, challenge);
                        return { category: 'too_many_attempts' };
                    }
                    const submittedHash = hashOtpCode({
                        challengeId: input.challengeId,
                        code: input.code,
                        jti: challenge.jti,
                        secret: input.secret,
                        siteId: challenge.siteId,
                    });
                    if (!isMatchingOtpHash(challenge.otpHash, submittedHash)) {
                        const remaining = challenge.attemptsRemaining - 1;
                        if (remaining <= 0) {
                            await removeChallengeAndPointer(directory, challenge);
                            return { category: 'too_many_attempts' };
                        }
                        await writeFile(
                            path,
                            JSON.stringify({ ...challenge, attemptsRemaining: remaining }),
                            {
                                encoding: 'utf8',
                                mode: 0o600,
                            },
                        );
                        return { category: 'invalid' };
                    }

                    await removeChallengeAndPointer(directory, challenge);
                    return { category: 'valid', challenge };
                },
            );
        },
    };
}

export function createInMemoryOtpChallengeStore(): OtpChallengeStore {
    process.emitWarning(
        'Using the in-memory OTP challenge store does not survive process restarts. Prefer the default file-backed store or Redis in real deployments.',
        { code: 'MAGICSSO_IN_MEMORY_OTP_STORE' },
    );
    const challenges = new Map<string, OtpChallenge>();
    const activeChallenges = new Map<string, string>();

    return {
        async create(challenge: OtpChallenge): Promise<void> {
            if (challenges.has(challenge.challengeId)) {
                throw new Error('OTP challenge already exists.');
            }
            const previousChallengeId = activeChallenges.get(challenge.rotationKey);
            if (typeof previousChallengeId === 'string') {
                challenges.delete(previousChallengeId);
            }
            challenges.set(challenge.challengeId, challenge);
            activeChallenges.set(challenge.rotationKey, challenge.challengeId);
        },
        async verify(input): Promise<OtpChallengeVerificationResult> {
            const challenge = challenges.get(input.challengeId);
            if (typeof challenge === 'undefined') {
                return { category: 'not_found' };
            }
            if (activeChallenges.get(challenge.rotationKey) !== challenge.challengeId) {
                challenges.delete(input.challengeId);
                return { category: 'consumed' };
            }
            if (challenge.expiresAt <= input.now) {
                challenges.delete(input.challengeId);
                activeChallenges.delete(challenge.rotationKey);
                return { category: 'expired' };
            }
            const submittedHash = hashOtpCode({
                challengeId: input.challengeId,
                code: input.code,
                jti: challenge.jti,
                secret: input.secret,
                siteId: challenge.siteId,
            });
            if (!isMatchingOtpHash(challenge.otpHash, submittedHash)) {
                challenge.attemptsRemaining -= 1;
                if (challenge.attemptsRemaining <= 0) {
                    challenges.delete(input.challengeId);
                    activeChallenges.delete(challenge.rotationKey);
                    return { category: 'too_many_attempts' };
                }
                return { category: 'invalid' };
            }
            challenges.delete(input.challengeId);
            activeChallenges.delete(challenge.rotationKey);
            return { category: 'valid', challenge };
        },
    };
}
