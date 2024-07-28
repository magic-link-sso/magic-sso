/**
 * server/src/dockerCompose.test.ts
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

import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const serverDir = dirname(fileURLToPath(import.meta.url));
const serverComposePath = join(serverDir, '../docker-compose.yml');

function readServerCompose(): string {
    return readFileSync(serverComposePath, 'utf8');
}

describe('server docker compose', () => {
    it('enables read-only hardening and ephemeral scratch storage', () => {
        const compose = readServerCompose();

        expect(compose).toContain('read_only: true');
        expect(compose).toContain('tmpfs:');
        expect(compose).toContain('/app/server/.magic-sso');
        expect(compose).toContain('/tmp');
        expect(compose).toContain('security_opt:');
        expect(compose).toContain('no-new-privileges:true');
        expect(compose).toContain('cap_drop:');
        expect(compose).toContain('- ALL');
    });
});
