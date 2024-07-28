/**
 * server/src/sessionRevocationStore.test.ts
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

import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { createFileSessionRevocationStore } from './sessionRevocationStore.js';

describe('file session revocation store', () => {
    let directory: string | undefined;

    afterEach(async () => {
        if (typeof directory === 'string') {
            await rm(directory, { recursive: true, force: true });
        }
        directory = undefined;
    });

    it('records revoked sessions until their expiry time', async () => {
        directory = await mkdtemp(join(tmpdir(), 'magic-sso-session-revocation-'));
        const store = await createFileSessionRevocationStore({
            directory,
        });

        await store.revoke('session-jti', Date.now() + 60_000);

        await expect(store.isRevoked('session-jti')).resolves.toBe(true);
        await expect(store.isRevoked('other-jti')).resolves.toBe(false);
    });

    it('ignores expired revocation markers', async () => {
        directory = await mkdtemp(join(tmpdir(), 'magic-sso-session-revocation-'));
        const store = await createFileSessionRevocationStore({
            directory,
            pruneIntervalMs: 1,
        });

        await store.revoke('expired-session-jti', Date.now() - 1_000);

        await expect(store.isRevoked('expired-session-jti')).resolves.toBe(false);
    });
});
