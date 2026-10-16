// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 Wojciech Polak

import { AsyncLocalStorage } from 'node:async_hooks';
import {
    closeSync,
    existsSync,
    fsyncSync,
    mkdirSync,
    openSync,
    readFileSync,
    unlinkSync,
    writeFileSync,
} from 'node:fs';
import { dirname, resolve } from 'node:path';

interface LockHandle {
    release(): void;
}
interface LockContext {
    path: string;
    active: boolean;
}
const context = new AsyncLocalStorage<LockContext>();

export class ManagerStateBusyError extends Error {
    readonly statusCode = 409;
    readonly code = 'manager_busy';

    constructor(path: string) {
        super(`Another manager write is already in progress: ${path}`);
    }
}

function ensureParentDirectory(filePath: string): void {
    mkdirSync(dirname(filePath), { recursive: true });
}

function removeFileIfExists(filePath: string): void {
    if (existsSync(filePath)) {
        unlinkSync(filePath);
    }
}

function isProcessAlive(pid: number): boolean {
    try {
        process.kill(pid, 0);
        return true;
    } catch (error) {
        if (typeof error === 'object' && error !== null && Reflect.get(error, 'code') === 'EPERM') {
            return true;
        }

        return false;
    }
}

function shouldRecoverStaleApplyLock(lockFilePath: string): boolean {
    if (!existsSync(lockFilePath)) {
        return false;
    }

    let parsedLockContents: unknown;
    try {
        parsedLockContents = JSON.parse(readFileSync(lockFilePath, 'utf8').trim());
    } catch {
        return false;
    }

    if (typeof parsedLockContents !== 'object' || parsedLockContents === null) {
        return false;
    }

    const pid = Reflect.get(parsedLockContents, 'pid');
    return typeof pid === 'number' && Number.isInteger(pid) && pid > 0 && !isProcessAlive(pid);
}

function acquireApplyLock(lockFilePath: string): LockHandle {
    ensureParentDirectory(lockFilePath);

    let fileDescriptor: number;
    try {
        fileDescriptor = openSync(lockFilePath, 'wx');
    } catch (error) {
        if (
            typeof error === 'object' &&
            error !== null &&
            Reflect.get(error, 'code') === 'EEXIST'
        ) {
            if (shouldRecoverStaleApplyLock(lockFilePath)) {
                removeFileIfExists(lockFilePath);
                return acquireApplyLock(lockFilePath);
            }

            throw new ManagerStateBusyError(lockFilePath);
        }

        throw error;
    }

    try {
        writeFileSync(
            fileDescriptor,
            `${JSON.stringify({ pid: process.pid, startedAt: new Date().toISOString() })}\n`,
            'utf8',
        );
        fsyncSync(fileDescriptor);
    } finally {
        closeSync(fileDescriptor);
    }

    return {
        release: () => {
            removeFileIfExists(lockFilePath);
        },
    };
}

function ownsLock(path: string): boolean {
    const current = context.getStore();
    return current?.active === true && current.path === path;
}

/** Protect one complete asynchronous read/modify/write transaction. */
export async function withManagerStateLock<T>(
    path: string,
    operation: () => Promise<T>,
    options: { independent?: boolean } = {},
): Promise<T> {
    const canonicalPath = resolve(path);
    if (!options.independent && ownsLock(canonicalPath)) {
        return operation();
    }
    const handle = acquireApplyLock(canonicalPath);
    const owner = { path: canonicalPath, active: true };
    try {
        return await context.run(owner, operation);
    } finally {
        owner.active = false;
        handle.release();
    }
}

/** Protect synchronous writes, including callers outside the CLI and HTTP API. */
export function withManagerStateLockSync<T>(path: string, operation: () => T): T {
    const canonicalPath = resolve(path);
    if (ownsLock(canonicalPath)) {
        return operation();
    }
    const handle = acquireApplyLock(canonicalPath);
    const owner = { path: canonicalPath, active: true };
    try {
        return context.run(owner, operation);
    } finally {
        owner.active = false;
        handle.release();
    }
}
