/**
 * manager/src/main.ts
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

import { buildApp } from './app.js';
import { loadManagerRuntimeSettings } from './settings.js';

async function main(): Promise<void> {
    const settings = loadManagerRuntimeSettings();
    if (typeof settings.service === 'undefined') {
        throw new Error(
            'Manager service settings are not configured. Add [service] to MAGICSSO_MANAGER_CONFIG_FILE.',
        );
    }

    const app = await buildApp({ settings });
    try {
        await app.listen({
            host: settings.service.host,
            port: settings.service.port,
        });
        app.log.info(
            {
                configFilePath: settings.configFilePath,
                managedSiteIds: settings.managedSiteIds,
                port: settings.service.port,
            },
            'Manager service is running',
        );
    } catch (error) {
        app.log.error({ err: error }, 'Failed to start manager service');
        process.exit(1);
    }
}

void main();
