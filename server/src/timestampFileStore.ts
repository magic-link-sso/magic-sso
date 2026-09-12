/**
 * server/src/timestampFileStore.ts
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

import { readdir, readFile, rm } from 'node:fs/promises';
import { join } from 'node:path';

/**
 * Shared primitives for the file-backed security stores. Each store keeps one
 * `<key>.txt` file per record whose only content is a millisecond timestamp, so
 * scanning, parsing and pruning are the same operation everywhere.
 */

interface TimestampFileEntry {
    filePath: string;
    /** Parsed file contents, or `Number.NaN` when the file held no valid integer. */
    timestampMs: number;
}

/** Build the per-record file path used by every timestamp-backed store. */
export function buildTimestampFilePath(directory: string, key: string): string {
    return join(directory, `${encodeURIComponent(key)}.txt`);
}

/**
 * Read every `*.txt` record in `directory`. Records that disappear mid-scan are
 * skipped rather than failing the whole sweep.
 */
async function readTimestampFiles(directory: string): Promise<TimestampFileEntry[]> {
    const entries = await readdir(directory, { withFileTypes: true });
    const timestampFiles: TimestampFileEntry[] = [];

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

        timestampFiles.push({
            filePath,
            timestampMs: Number.parseInt(contents.trim(), 10),
        });
    }

    return timestampFiles;
}

/** Remove every record in `directory` whose expiry timestamp has passed. */
export async function pruneExpiredTimestampFiles(directory: string, nowMs: number): Promise<void> {
    for (const { filePath, timestampMs } of await readTimestampFiles(directory)) {
        if (Number.isFinite(timestampMs) && timestampMs <= nowMs) {
            await rm(filePath, { force: true });
        }
    }
}

/**
 * Return the timestamps still inside the window starting at `windowStartMs`, in
 * ascending order, removing every record that has fallen out of it.
 */
export async function collectRecentTimestamps(
    directory: string,
    windowStartMs: number,
): Promise<number[]> {
    const recentTimestamps: number[] = [];

    for (const { filePath, timestampMs } of await readTimestampFiles(directory)) {
        if (Number.isFinite(timestampMs) && timestampMs > windowStartMs) {
            recentTimestamps.push(timestampMs);
            continue;
        }

        await rm(filePath, { force: true });
    }

    recentTimestamps.sort((left, right) => left - right);
    return recentTimestamps;
}
