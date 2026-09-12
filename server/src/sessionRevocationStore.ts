/**
 * server/src/sessionRevocationStore.ts
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

import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { buildTimestampFilePath, pruneExpiredTimestampFiles } from './timestampFileStore.js';

export interface SessionRevocationStore {
    isRevoked(jti: string): Promise<boolean>;
    revoke(jti: string, expiresAt: number): Promise<void>;
}

export async function createFileSessionRevocationStore(options: {
    directory: string;
    pruneIntervalMs?: number;
}): Promise<SessionRevocationStore> {
    const directory = resolve(options.directory);
    const pruneIntervalMs = options.pruneIntervalMs ?? 60_000;
    let nextPruneAt = 0;

    await mkdir(directory, { recursive: true });

    return {
        async isRevoked(jti: string): Promise<boolean> {
            const nowMs = Date.now();
            if (nowMs >= nextPruneAt) {
                await pruneExpiredTimestampFiles(directory, nowMs);
                nextPruneAt = nowMs + pruneIntervalMs;
            }

            const filePath = buildTimestampFilePath(directory, jti);
            try {
                const contents = await readFile(filePath, 'utf8');
                const expiresAt = Number.parseInt(contents.trim(), 10);
                if (!Number.isFinite(expiresAt) || expiresAt <= nowMs) {
                    await rm(filePath, { force: true });
                    return false;
                }

                return true;
            } catch (error) {
                if (error instanceof Error && 'code' in error && error.code === 'ENOENT') {
                    return false;
                }

                throw error;
            }
        },
        async revoke(jti: string, expiresAt: number): Promise<void> {
            await writeFile(buildTimestampFilePath(directory, jti), `${expiresAt}\n`, {
                flag: 'w',
                mode: 0o600,
            });
        },
    };
}
