// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 Wojciech Polak

import type { RedisSecurityStateClient } from './redisSecurityState.js';
import {
    browserSsoRecordSchema,
    createBrowserSsoStore,
    hashBrowserSsoValue,
    type BrowserSsoBackend,
    type BrowserSsoRecord,
    type BrowserSsoStore,
} from './browserSsoStore.js';

// Compare every read (including the active session and absent records) before
// applying any write. A failed comparison retries validation, never GET + DEL.
// All keys are explicitly supplied to Lua and share a Redis Cluster hash slot.
const COMMIT_SCRIPT = `
-- browser_sso_commit_v1
for i = 1, #KEYS do
    local expected = ARGV[(i - 1) * 3 + 1]
    local actual = redis.call('GET', KEYS[i]) or ''
    if actual ~= expected then return 0 end
end
for i = 1, #KEYS do
    local value = ARGV[(i - 1) * 3 + 2]
    local expires = tonumber(ARGV[(i - 1) * 3 + 3])
    if expires == -1 then
        redis.call('DEL', KEYS[i])
    elseif expires > 0 then
        redis.call('SET', KEYS[i], value, 'PXAT', expires)
    end
end
return 1
`;

function commitArguments(
    prefix: string,
    reads: Map<string, string | null>,
    writes: Map<string, BrowserSsoRecord | null>,
): { keys: string[]; args: Array<string | number> } {
    const keys: string[] = [];
    const args: Array<string | number> = [];
    for (const [id, previous] of reads) {
        keys.push(`${prefix}${id}`);
        const record = writes.get(id);
        args.push(
            previous ?? '',
            record === null || record === undefined ? '' : JSON.stringify(record),
            !writes.has(id) ? 0 : record === null || record === undefined ? -1 : record.expiresAt,
        );
    }
    return { keys, args };
}

export function createRedisBrowserSsoStore(options: {
    client: RedisSecurityStateClient;
    keyPrefix: string;
}): BrowserSsoStore {
    const prefix = `${options.keyPrefix}:browser-sso:{${hashBrowserSsoValue(options.keyPrefix)}}:`;
    const backend: BrowserSsoBackend = {
        async run(now, operation) {
            for (let attempt = 0; attempt < 64; attempt += 1) {
                const reads = new Map<string, string | null>();
                const writes = new Map<string, BrowserSsoRecord | null>();
                const read = async (id: string): Promise<BrowserSsoRecord | null> => {
                    if (writes.has(id)) {
                        return writes.get(id) ?? null;
                    }
                    if (!reads.has(id)) {
                        reads.set(id, await options.client.get(`${prefix}${id}`));
                    }
                    const payload = reads.get(id);
                    if (payload === null || payload === undefined) {
                        return null;
                    }
                    const parsed: unknown = JSON.parse(payload);
                    const record = browserSsoRecordSchema.parse(parsed);
                    if (record.expiresAt <= now) {
                        writes.set(id, null);
                        return null;
                    }
                    return record;
                };
                const result = await operation({
                    get: read,
                    async set(id, record) {
                        // Blind writes must also compare the previous value.
                        await read(id);
                        writes.set(
                            id,
                            record === null ? null : browserSsoRecordSchema.parse(record),
                        );
                    },
                });
                if (reads.size === 0) {
                    return result;
                }
                const { keys, args } = commitArguments(prefix, reads, writes);
                const committed = await options.client.eval(
                    COMMIT_SCRIPT,
                    keys.length,
                    ...keys,
                    ...args,
                );
                if (committed === 1) {
                    return result;
                }
                if (committed !== 0) {
                    throw new Error('Invalid Redis browser SSO transaction result.');
                }
            }
            throw new Error('Redis browser SSO transaction contention limit reached.');
        },
    };
    return createBrowserSsoStore(backend);
}
