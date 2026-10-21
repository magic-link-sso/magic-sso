// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 Wojciech Polak

import { randomUUID } from 'node:crypto';
import { chmod, mkdir, open, readFile, rename, rm } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { z } from 'zod';
import {
    browserSsoRecordSchema,
    createBrowserSsoStore,
    type BrowserSsoBackend,
    type BrowserSsoRecord,
    type BrowserSsoStore,
} from './browserSsoStore.js';

// File mode supports one issuer process. Separate instances in that process
// share a queue; use Redis for replicas rather than sharing a filesystem.
const queues = new Map<string, Promise<void>>();
const DEFAULT_MAX_RECORDS = 10_000;
const snapshotSchema = z
    .object({
        version: z.literal(1),
        records: z.record(
            z.string().regex(/^(session|request|code|binding|bootstrap):[a-f0-9]{64}$/),
            browserSsoRecordSchema,
        ),
    })
    .strict();

async function readSnapshot(path: string): Promise<Map<string, BrowserSsoRecord>> {
    try {
        const value: unknown = JSON.parse(await readFile(path, 'utf8'));
        return new Map(Object.entries(snapshotSchema.parse(value).records));
    } catch (error) {
        if (error instanceof Error && 'code' in error && error.code === 'ENOENT') {
            return new Map();
        }
        throw error;
    }
}

async function saveSnapshot(path: string, records: Map<string, BrowserSsoRecord>): Promise<void> {
    const temporaryPath = `${path}.${randomUUID()}.tmp`;
    try {
        const handle = await open(temporaryPath, 'wx', 0o600);
        try {
            await handle.writeFile(
                JSON.stringify({ version: 1, records: Object.fromEntries(records) }),
            );
            await handle.sync();
        } finally {
            await handle.close();
        }
        await rename(temporaryPath, path);
    } finally {
        await rm(temporaryPath, { force: true });
    }
}

export async function createFileBrowserSsoStore(options: {
    directory: string;
    maxRecords?: number;
}): Promise<BrowserSsoStore> {
    const maxRecords = options.maxRecords ?? DEFAULT_MAX_RECORDS;
    if (!Number.isSafeInteger(maxRecords) || maxRecords < 1) {
        throw new Error('Browser SSO file record limit must be a positive integer.');
    }
    const directory = resolve(options.directory);
    await mkdir(directory, { recursive: true, mode: 0o700 });
    await chmod(directory, 0o700);
    const path = join(directory, 'browser-sso-v1.json');
    // Corruption and permissions failures must fail startup, never log users out
    // by quietly substituting an empty in-memory store.
    await readSnapshot(path);
    const backend: BrowserSsoBackend = {
        async run(now, operation) {
            const previous = queues.get(path) ?? Promise.resolve();
            let release: () => void = () => undefined;
            const current = new Promise<void>((resolvePromise) => {
                release = resolvePromise;
            });
            queues.set(path, current);
            await previous;
            try {
                const records = await readSnapshot(path);
                let changed = false;
                for (const [id, record] of records) {
                    if (record.expiresAt <= now) {
                        records.delete(id);
                        changed = true;
                    }
                }
                const initialSize = records.size;
                const result = await operation({
                    async get(id) {
                        return records.get(id) ?? null;
                    },
                    async hasRequestCapacity(additionalRecords) {
                        if (!Number.isSafeInteger(additionalRecords) || additionalRecords < 1) {
                            throw new Error('Invalid Browser SSO record reservation.');
                        }
                        let completionReservations = 0;
                        for (const record of records.values()) {
                            if (record.kind === 'request' || record.kind === 'bootstrap') {
                                completionReservations += 1;
                            }
                        }
                        return (
                            records.size + completionReservations + additionalRecords + 1 <=
                            maxRecords
                        );
                    },
                    async set(id, record) {
                        if (record === null) {
                            changed = records.delete(id) || changed;
                        } else {
                            records.set(id, browserSsoRecordSchema.parse(record));
                            changed = true;
                        }
                    },
                });
                if (records.size > maxRecords && records.size > initialSize) {
                    throw new Error('Browser SSO file record capacity exceeded.');
                }
                if (changed) {
                    await saveSnapshot(path, records);
                }
                return result;
            } finally {
                release();
                if (queues.get(path) === current) {
                    queues.delete(path);
                }
            }
        },
    };
    return createBrowserSsoStore(backend);
}
