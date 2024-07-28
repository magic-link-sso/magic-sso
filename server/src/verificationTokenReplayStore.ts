/**
 * server/src/verificationTokenReplayStore.ts
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

import { chmod, mkdir, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';

export interface VerificationTokenReplayStore {
    consume(jti: string, expiresAt: number): Promise<boolean>;
}

function buildTokenFilePath(directory: string, jti: string): string {
    return join(directory, `${encodeURIComponent(jti)}.txt`);
}

async function pruneExpiredTokens(directory: string, nowMs: number): Promise<void> {
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

        const expiresAt = Number.parseInt(contents.trim(), 10);
        if (Number.isFinite(expiresAt) && expiresAt <= nowMs) {
            await rm(filePath, { force: true });
        }
    }
}

export function createInMemoryVerificationTokenReplayStore(): VerificationTokenReplayStore {
    process.emitWarning(
        'Using the in-memory verification token replay store does not survive process restarts. Prefer the default file-backed store or a persistent adapter in real deployments.',
        {
            code: 'MAGICSSO_IN_MEMORY_REPLAY_STORE',
        },
    );
    const consumedTokens = new Set<string>();

    return {
        async consume(jti: string): Promise<boolean> {
            if (consumedTokens.has(jti)) {
                return false;
            }

            consumedTokens.add(jti);
            return true;
        },
    };
}

export async function createFileVerificationTokenReplayStore(options: {
    directory: string;
    pruneIntervalMs?: number;
}): Promise<VerificationTokenReplayStore> {
    const directory = resolve(options.directory);
    const pruneIntervalMs = options.pruneIntervalMs ?? 60_000;
    let nextPruneAt = 0;

    await mkdir(directory, { mode: 0o700, recursive: true });
    await chmod(directory, 0o700);

    return {
        async consume(jti: string, expiresAt: number): Promise<boolean> {
            const nowMs = Date.now();
            if (nowMs >= nextPruneAt) {
                await pruneExpiredTokens(directory, nowMs);
                nextPruneAt = nowMs + pruneIntervalMs;
            }

            try {
                await writeFile(buildTokenFilePath(directory, jti), `${expiresAt}\n`, {
                    flag: 'wx',
                    mode: 0o600,
                });
                return true;
            } catch (error) {
                if (error instanceof Error && 'code' in error && error.code === 'EEXIST') {
                    return false;
                }

                throw error;
            }
        },
    };
}
