/**
 * server/src/logger.test.ts
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
import { createLoggerOptions } from './logger.js';

describe('createLoggerOptions', () => {
    it('returns plain JSON logger options by default', () => {
        expect(
            createLoggerOptions({
                logFormat: 'json',
                logLevel: 'info',
            }),
        ).toEqual({
            level: 'info',
        });
    });

    it('returns pretty logger transport options when requested', () => {
        expect(
            createLoggerOptions({
                logFormat: 'pretty',
                logLevel: 'debug',
            }),
        ).toEqual({
            level: 'debug',
            transport: {
                target: 'pino-pretty',
                options: {
                    colorize: true,
                    ignore: 'pid,hostname',
                    translateTime: 'SYS:standard',
                },
            },
        });
    });
});
