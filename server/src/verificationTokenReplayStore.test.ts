/**
 * server/src/verificationTokenReplayStore.test.ts
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

import {
    chmodSync,
    existsSync,
    mkdirSync,
    mkdtempSync,
    rmSync,
    statSync,
    writeFileSync,
} from 'node:fs';
import { readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
    createFileVerificationTokenReplayStore,
    createInMemoryVerificationTokenReplayStore,
} from './verificationTokenReplayStore.js';

function fileMode(path: string): number {
    return statSync(path).mode & 0o777;
}

vi.mock('node:fs/promises', async (importOriginal) => {
    const actual = await importOriginal<typeof import('node:fs/promises')>();
    return {
        ...actual,
        readFile: vi.fn(actual.readFile),
        writeFile: vi.fn(actual.writeFile),
    };
});

describe('createFileVerificationTokenReplayStore', () => {
    let storeDir: string;

    beforeEach(() => {
        storeDir = mkdtempSync(join(tmpdir(), 'magic-sso-store-'));
        vi.clearAllMocks();
    });

    afterEach(() => {
        rmSync(storeDir, { recursive: true, force: true });
    });

    it('accepts a new token', async () => {
        const store = await createFileVerificationTokenReplayStore({ directory: storeDir });
        await expect(store.consume('jti-1', Date.now() + 60_000)).resolves.toBe(true);
    });

    it('uses private permissions for the store directory and token files', async () => {
        chmodSync(storeDir, 0o755);

        const store = await createFileVerificationTokenReplayStore({ directory: storeDir });
        await expect(store.consume('jti-1', Date.now() + 60_000)).resolves.toBe(true);

        expect(fileMode(storeDir)).toBe(0o700);
        expect(fileMode(join(storeDir, 'jti-1.txt'))).toBe(0o600);
    });

    it('rejects a replayed token', async () => {
        const store = await createFileVerificationTokenReplayStore({ directory: storeDir });
        await expect(store.consume('jti-1', Date.now() + 60_000)).resolves.toBe(true);
        await expect(store.consume('jti-1', Date.now() + 60_000)).resolves.toBe(false);
    });

    it('skips non-.txt files during pruning', async () => {
        const jsonFile = join(storeDir, 'metadata.json');
        writeFileSync(jsonFile, '{}', 'utf8');

        const store = await createFileVerificationTokenReplayStore({
            directory: storeDir,
            pruneIntervalMs: 0,
        });
        await expect(store.consume('jti-1', Date.now() + 60_000)).resolves.toBe(true);
        expect(existsSync(jsonFile)).toBe(true);
    });

    it('skips subdirectories during pruning', async () => {
        const subDir = join(storeDir, 'subdir');
        mkdirSync(subDir);

        const store = await createFileVerificationTokenReplayStore({
            directory: storeDir,
            pruneIntervalMs: 0,
        });
        await expect(store.consume('jti-1', Date.now() + 60_000)).resolves.toBe(true);
        expect(existsSync(subDir)).toBe(true);
    });

    it('deletes expired token files during pruning', async () => {
        const pastMs = Date.now() - 1000;
        const expiredJti = 'expired-jti';
        const expiredFilePath = join(storeDir, `${encodeURIComponent(expiredJti)}.txt`);
        writeFileSync(expiredFilePath, `${pastMs}\n`, 'utf8');

        const store = await createFileVerificationTokenReplayStore({
            directory: storeDir,
            pruneIntervalMs: 0,
        });
        await store.consume('new-jti', Date.now() + 60_000);

        expect(existsSync(expiredFilePath)).toBe(false);
    });

    it('propagates non-ENOENT errors from readFile during pruning', async () => {
        writeFileSync(join(storeDir, 'some-token.txt'), '9999999999999\n', 'utf8');

        const permissionError = Object.assign(new Error('Permission denied'), { code: 'EACCES' });
        vi.mocked(readFile).mockRejectedValueOnce(permissionError);

        const store = await createFileVerificationTokenReplayStore({
            directory: storeDir,
            pruneIntervalMs: 0,
        });
        await expect(store.consume('jti-new', Date.now() + 60_000)).rejects.toThrow(
            'Permission denied',
        );
    });

    it('propagates non-EEXIST errors from writeFile', async () => {
        const diskFullError = Object.assign(new Error('No space left on device'), {
            code: 'ENOSPC',
        });
        vi.mocked(writeFile).mockRejectedValueOnce(diskFullError);

        const store = await createFileVerificationTokenReplayStore({
            directory: storeDir,
            pruneIntervalMs: 0,
        });
        await expect(store.consume('jti-1', Date.now() + 60_000)).rejects.toThrow(
            'No space left on device',
        );
    });
});

describe('createInMemoryVerificationTokenReplayStore', () => {
    afterEach(() => {
        vi.restoreAllMocks();
    });

    it('warns that the in-memory replay store does not survive restarts', async () => {
        const emitWarningSpy = vi.spyOn(process, 'emitWarning').mockImplementation(() => undefined);

        const replayStore = createInMemoryVerificationTokenReplayStore();

        expect(emitWarningSpy).toHaveBeenCalledWith(
            'Using the in-memory verification token replay store does not survive process restarts. Prefer the default file-backed store or a persistent adapter in real deployments.',
            {
                code: 'MAGICSSO_IN_MEMORY_REPLAY_STORE',
            },
        );
        await expect(replayStore.consume('token-jti', Date.now() + 60_000)).resolves.toBe(true);
        await expect(replayStore.consume('token-jti', Date.now() + 60_000)).resolves.toBe(false);
    });
});
