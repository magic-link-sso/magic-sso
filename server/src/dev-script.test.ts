/**
 * server/src/dev-script.test.ts
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

import { readFile } from 'node:fs/promises';
import { describe, expect, it } from 'vitest';

describe('server dev script', () => {
    it('uses Node watch mode with tsx import for clean shutdowns', async () => {
        const packageJson = await readFile(new URL('../package.json', import.meta.url), 'utf8');

        expect(packageJson).toContain('"dev": "node --watch --import tsx src/main.ts"');
    });
});
