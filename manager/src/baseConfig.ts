/**
 * manager/src/baseConfig.ts
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
import {
    parseMagicSsoTomlConfig,
    type MagicSsoTomlConfig,
    type MagicSsoTomlSite,
} from '@magic-link-sso/config-core';
import { assertBootstrapAdminSiteIsNotManaged, type ManagerRuntimeSettings } from './settings.js';
import {
    createEmptyManagerState,
    normalizeManagerState,
    type ManagedSiteState,
    type ManagerState,
} from './state.js';

export interface ManagedSiteBinding {
    siteConfig: MagicSsoTomlSite;
    siteState: ManagedSiteState;
}

export interface ManagedSiteSelection {
    baseConfig: MagicSsoTomlConfig;
    managedSites: ManagedSiteBinding[];
    unmanagedSites: MagicSsoTomlSite[];
}

function cloneSiteConfig(siteConfig: MagicSsoTomlSite): MagicSsoTomlSite {
    return structuredClone(siteConfig);
}

export function loadBaseConfig(settings: ManagerRuntimeSettings): MagicSsoTomlConfig {
    const fileContents = readFileSync(settings.paths.baseConfigFile, 'utf8');
    return parseMagicSsoTomlConfig(fileContents, settings.paths.baseConfigFile);
}

export function selectManagedSites(
    baseConfig: MagicSsoTomlConfig,
    state: ManagerState,
    settings: ManagerRuntimeSettings,
): ManagedSiteSelection {
    assertBootstrapAdminSiteIsNotManaged(settings);
    const sitesById = new Map(baseConfig.sites.map((site) => [site.id, cloneSiteConfig(site)]));
    const normalizedState = normalizeManagerState(state);
    const seededState = createEmptyManagerState(settings.managedSiteIds);
    const stateSiteIds = Object.keys(normalizedState.managedSites);

    for (const siteId of stateSiteIds) {
        if (!settings.managedSiteIds.includes(siteId)) {
            throw new Error(`Manager state contains an unmanaged site: ${siteId}`);
        }
    }

    const managedSites = settings.managedSiteIds.map((siteId): ManagedSiteBinding => {
        const siteConfig = sitesById.get(siteId);
        if (typeof siteConfig === 'undefined') {
            throw new Error(
                `Managed site ${siteId} is missing from ${settings.paths.baseConfigFile}.`,
            );
        }

        const siteState = normalizedState.managedSites[siteId] ?? seededState.managedSites[siteId];
        if (typeof siteState === 'undefined') {
            throw new Error(`Managed site ${siteId} is missing from manager state.`);
        }

        return {
            siteConfig,
            siteState,
        };
    });

    const managedSiteIds = new Set(settings.managedSiteIds);
    const unmanagedSites = baseConfig.sites
        .filter((site) => !managedSiteIds.has(site.id))
        .map((site) => cloneSiteConfig(site));

    return {
        baseConfig: structuredClone(baseConfig),
        managedSites,
        unmanagedSites,
    };
}
