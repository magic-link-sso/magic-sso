/**
 * server/src/main.ts
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

import 'dotenv/config';
import { randomUUID } from 'node:crypto';
import { buildApp } from './app.js';
import { loadConfig, readConfigFilePath } from './config.js';
import { shouldVerifyStartupAppUrl, verifyStartupAppUrl } from './startupProbe.js';

async function start(): Promise<void> {
    const configFilePath = readConfigFilePath();
    const config = loadConfig();
    const startupProbeToken = randomUUID();
    const app = await buildApp({ config, startupProbeToken });

    const shutdown = async (signal: NodeJS.Signals): Promise<void> => {
        app.log.info({ signal }, 'Shutting down');
        await app.close();
        process.exit(0);
    };

    process.on('SIGINT', () => {
        void shutdown('SIGINT');
    });
    process.on('SIGTERM', () => {
        void shutdown('SIGTERM');
    });

    try {
        await app.listen({
            port: config.appPort,
            host: '0.0.0.0',
        });

        if (shouldVerifyStartupAppUrl(config.appUrl)) {
            try {
                await verifyStartupAppUrl({
                    appUrl: config.appUrl,
                    startupProbeToken,
                });
            } catch (error) {
                app.log.error(
                    { err: error },
                    'Configured appUrl does not reach this server instance',
                );
                await app.close();
                process.exit(1);
            }
        }

        app.log.info(
            {
                appUrl: config.appUrl,
                configFilePath,
                port: config.appPort,
                siteIds: config.sites.map((site) => site.id),
            },
            'Server is running with TOML config',
        );
    } catch (error) {
        app.log.error({ err: error }, 'Failed to start server');
        process.exit(1);
    }
}

void start();
