/**
 * server/src/logger.ts
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

import type { AppConfig } from './config.js';

interface PrettyLoggerTransportOptions {
    colorize: boolean;
    ignore: string;
    translateTime: string;
}

interface PrettyLoggerTransport {
    options: PrettyLoggerTransportOptions;
    target: 'pino-pretty';
}

export interface AppLoggerOptions {
    level: AppConfig['logLevel'];
    transport?: PrettyLoggerTransport;
}

export function createLoggerOptions(
    config: Pick<AppConfig, 'logFormat' | 'logLevel'>,
): AppLoggerOptions {
    if (config.logFormat === 'pretty') {
        return {
            level: config.logLevel,
            transport: {
                target: 'pino-pretty',
                options: {
                    colorize: true,
                    ignore: 'pid,hostname',
                    translateTime: 'SYS:standard',
                },
            },
        };
    }

    return {
        level: config.logLevel,
    };
}
