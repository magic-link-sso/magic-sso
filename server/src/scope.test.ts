/**
 * server/src/scope.test.ts
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

import { describe, expect, it } from 'vitest';
import { FULL_ACCESS_SCOPE, normalizeRequestedScope } from './scope.js';

describe('normalizeRequestedScope', () => {
    it('returns full access scope for undefined', () => {
        expect(normalizeRequestedScope(undefined)).toBe(FULL_ACCESS_SCOPE);
    });

    it('returns full access scope for an empty string', () => {
        expect(normalizeRequestedScope('')).toBe(FULL_ACCESS_SCOPE);
    });

    it('returns full access scope for a whitespace-only string', () => {
        expect(normalizeRequestedScope('   ')).toBe(FULL_ACCESS_SCOPE);
    });

    it('returns a non-empty scope unchanged', () => {
        expect(normalizeRequestedScope('album-A')).toBe('album-A');
    });

    it('trims surrounding whitespace from a non-empty scope', () => {
        expect(normalizeRequestedScope('  read:users  ')).toBe('read:users');
    });
});
