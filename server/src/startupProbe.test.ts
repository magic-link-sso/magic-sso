/**
 * server/src/startupProbe.test.ts
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
import {
    getStartupProbeHeaderName,
    shouldVerifyStartupAppUrl,
    verifyStartupAppUrl,
} from './startupProbe.js';

describe('startupProbe', () => {
    it('verifies localhost and loopback app URLs', () => {
        expect(shouldVerifyStartupAppUrl('http://localhost:3000')).toBe(true);
        expect(shouldVerifyStartupAppUrl('http://127.0.0.1:3000')).toBe(true);
        expect(shouldVerifyStartupAppUrl('http://[::1]:3000')).toBe(true);
        expect(shouldVerifyStartupAppUrl('https://sso.example.com')).toBe(false);
    });

    it('accepts the health response from the same server instance', async () => {
        await expect(
            verifyStartupAppUrl({
                appUrl: 'http://localhost:3000',
                fetchImpl: async () =>
                    new Response(JSON.stringify({ status: 'ok' }), {
                        headers: {
                            [getStartupProbeHeaderName()]: 'probe-token',
                            'content-type': 'application/json',
                        },
                        status: 200,
                    }),
                startupProbeToken: 'probe-token',
            }),
        ).resolves.toBeUndefined();
    });

    it('fails when localhost resolves to a different process', async () => {
        await expect(
            verifyStartupAppUrl({
                appUrl: 'http://localhost:3000',
                fetchImpl: async () =>
                    new Response('<html>other app</html>', {
                        headers: {
                            'content-type': 'text/html; charset=utf-8',
                        },
                        status: 200,
                    }),
                startupProbeToken: 'probe-token',
            }),
        ).rejects.toThrowError(
            'Startup verification failed for http://localhost:3000/healthz: expected this Magic Link SSO instance to answer, but received a different response. Another process may already be serving http://localhost:3000.',
        );
    });

    it('returns false for a malformed URL', () => {
        expect(shouldVerifyStartupAppUrl('not a url')).toBe(false);
        expect(shouldVerifyStartupAppUrl('')).toBe(false);
        expect(shouldVerifyStartupAppUrl(':::bad')).toBe(false);
    });

    it('wraps a non-Error fetch failure with a descriptive message', async () => {
        await expect(
            verifyStartupAppUrl({
                appUrl: 'http://localhost:3000',
                fetchImpl: async () => {
                    throw 'connection refused';
                },
                startupProbeToken: 'probe-token',
            }),
        ).rejects.toThrowError(
            'Startup verification failed for http://localhost:3000/healthz: connection refused. Another process may already be serving http://localhost:3000.',
        );
    });
});
