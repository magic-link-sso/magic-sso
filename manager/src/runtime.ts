/**
 * manager/src/runtime.ts
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

import { existsSync, readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import {
    buildSiteAccessRules,
    parseMagicSsoConfigToml,
    parseMagicSsoTomlConfig,
    renderSiteAccessRules,
    stringifyMagicSsoTomlConfig,
    type AppConfig,
    type MagicSsoTomlConfig,
    type MagicSsoTomlSite,
} from '@magic-link-sso/config-core';
import { loadBaseConfig, selectManagedSites, type ManagedSiteSelection } from './baseConfig.js';
import { type ManagerRuntimeSettings } from './settings.js';
import {
    createEmptyManagerState,
    normalizeManagerState,
    resetManagerStateApplyMetadata,
    type ManagedSiteState,
    type ManagerGrant,
    type ManagerState,
} from './state.js';

export interface ManagedSiteDiff {
    addedFullAccessEmails: string[];
    addedScopedGrants: ManagerGrant[];
    removedFullAccessEmails: string[];
    removedScopedGrants: ManagerGrant[];
    siteId: string;
}

export interface ManagedSiteDiffSummary {
    changedSites: ManagedSiteDiff[];
    hasChanges: boolean;
}

export interface RuntimePlan {
    baseConfig: MagicSsoTomlConfig;
    baseConfigHash: string;
    runtimeConfig: MagicSsoTomlConfig;
    runtimeConfigHash: string;
    runtimeToml: string;
    selection: ManagedSiteSelection;
    validatedRuntimeConfig: AppConfig;
}

export interface ConfigDriftStatus {
    baseConfigDrifted: boolean;
    currentBaseConfigHash: string;
    currentRuntimeConfigHash: string | undefined;
    expectedBaseConfigHash: string;
    expectedRuntimeConfigHash: string;
    runtimeConfigDrifted: boolean;
    runtimeConfigExists: boolean;
}

function hashContents(value: string): string {
    return createHash('sha256').update(value).digest('hex');
}

function cloneSiteConfig(siteConfig: MagicSsoTomlSite): MagicSsoTomlSite {
    return structuredClone(siteConfig);
}

function createAccessRulesFromGrants(grants: readonly ManagerGrant[]): Map<string, Set<string>> {
    const accessRules = new Map<string, Set<string>>();
    for (const grant of grants) {
        accessRules.set(grant.email, new Set(grant.scopes));
    }
    return accessRules;
}

function renderManagedSite(
    siteConfig: MagicSsoTomlSite,
    grants: readonly ManagerGrant[],
): MagicSsoTomlSite {
    const renderedAccessRules = renderSiteAccessRules(createAccessRulesFromGrants(grants));
    return {
        ...cloneSiteConfig(siteConfig),
        accessRules: renderedAccessRules.accessRules,
        allowedEmails: renderedAccessRules.allowedEmails,
    };
}

function createGrantSnapshot(siteConfig: MagicSsoTomlSite): {
    fullAccessEmails: string[];
    scopedGrants: ManagerGrant[];
} {
    const renderedAccessRules = renderSiteAccessRules(buildSiteAccessRules(siteConfig));
    return {
        fullAccessEmails: renderedAccessRules.allowedEmails,
        scopedGrants: renderedAccessRules.accessRules.map(
            (grant): ManagerGrant => ({
                email: grant.email,
                scopes: grant.scopes,
            }),
        ),
    };
}

function createManagedSiteStateFromSiteConfig(
    siteConfig: MagicSsoTomlSite,
    existingSiteState: ManagedSiteState,
): ManagedSiteState {
    const grantSnapshot = createGrantSnapshot(siteConfig);
    const discoveredScopes = grantSnapshot.scopedGrants.flatMap((grant) => grant.scopes);

    return {
        grants: [
            ...grantSnapshot.fullAccessEmails.map(
                (email): ManagerGrant => ({
                    email,
                    scopes: ['*'],
                }),
            ),
            ...grantSnapshot.scopedGrants,
        ],
        scopeCatalog: [...existingSiteState.scopeCatalog, ...discoveredScopes],
    };
}

function diffStringArrays(
    currentValues: readonly string[],
    nextValues: readonly string[],
): {
    added: string[];
    removed: string[];
} {
    const currentSet = new Set(currentValues);
    const nextSet = new Set(nextValues);
    const added = nextValues.filter((value) => !currentSet.has(value));
    const removed = currentValues.filter((value) => !nextSet.has(value));
    return {
        added,
        removed,
    };
}

function diffGrants(
    currentGrants: readonly ManagerGrant[],
    nextGrants: readonly ManagerGrant[],
): {
    added: ManagerGrant[];
    removed: ManagerGrant[];
} {
    const createGrantKey = (grant: ManagerGrant): string =>
        `${grant.email}:${grant.scopes.join(',')}`;
    const currentByKey = new Map(currentGrants.map((grant) => [createGrantKey(grant), grant]));
    const nextByKey = new Map(nextGrants.map((grant) => [createGrantKey(grant), grant]));
    const added = nextGrants.filter((grant) => !currentByKey.has(createGrantKey(grant)));
    const removed = currentGrants.filter((grant) => !nextByKey.has(createGrantKey(grant)));
    return {
        added,
        removed,
    };
}

export function validateRuntimeToml(runtimeToml: string, runtimeConfigFilePath: string): AppConfig {
    return parseMagicSsoConfigToml(runtimeToml, runtimeConfigFilePath);
}

export function buildRuntimePlan(
    state: ManagerState,
    settings: ManagerRuntimeSettings,
): RuntimePlan {
    const baseConfigContents = readFileSync(settings.paths.baseConfigFile, 'utf8');
    const baseConfig = loadBaseConfig(settings);
    const selection = selectManagedSites(baseConfig, state, settings);
    const managedSiteIds = new Map(
        selection.managedSites.map((managedSite) => [managedSite.siteConfig.id, managedSite]),
    );
    const runtimeConfig: MagicSsoTomlConfig = {
        ...structuredClone(baseConfig),
        sites: baseConfig.sites
            .map((siteConfig) => {
                const managedSite = managedSiteIds.get(siteConfig.id);
                return typeof managedSite === 'undefined'
                    ? cloneSiteConfig(siteConfig)
                    : renderManagedSite(managedSite.siteConfig, managedSite.siteState.grants);
            })
            .sort((left, right) => left.id.localeCompare(right.id)),
    };
    const runtimeToml = stringifyMagicSsoTomlConfig(runtimeConfig);

    return {
        baseConfig,
        baseConfigHash: hashContents(baseConfigContents),
        runtimeConfig,
        runtimeConfigHash: hashContents(runtimeToml),
        runtimeToml,
        selection,
        validatedRuntimeConfig: validateRuntimeToml(runtimeToml, settings.paths.runtimeConfigFile),
    };
}

export function summarizeManagedConfigDiff(
    currentConfig: MagicSsoTomlConfig,
    nextConfig: MagicSsoTomlConfig,
    managedSiteIds: readonly string[],
): ManagedSiteDiffSummary {
    const currentSites = new Map(currentConfig.sites.map((site) => [site.id, site]));
    const nextSites = new Map(nextConfig.sites.map((site) => [site.id, site]));
    const changedSites = managedSiteIds
        .map((siteId): ManagedSiteDiff | undefined => {
            const currentSite = currentSites.get(siteId);
            const nextSite = nextSites.get(siteId);
            if (typeof currentSite === 'undefined' || typeof nextSite === 'undefined') {
                throw new Error(`Managed site ${siteId} is missing from the diff inputs.`);
            }

            const currentSnapshot = createGrantSnapshot(currentSite);
            const nextSnapshot = createGrantSnapshot(nextSite);
            const fullAccessDiff = diffStringArrays(
                currentSnapshot.fullAccessEmails,
                nextSnapshot.fullAccessEmails,
            );
            const scopedGrantDiff = diffGrants(
                currentSnapshot.scopedGrants,
                nextSnapshot.scopedGrants,
            );

            if (
                fullAccessDiff.added.length === 0 &&
                fullAccessDiff.removed.length === 0 &&
                scopedGrantDiff.added.length === 0 &&
                scopedGrantDiff.removed.length === 0
            ) {
                return undefined;
            }

            return {
                addedFullAccessEmails: fullAccessDiff.added,
                addedScopedGrants: scopedGrantDiff.added,
                removedFullAccessEmails: fullAccessDiff.removed,
                removedScopedGrants: scopedGrantDiff.removed,
                siteId,
            };
        })
        .flatMap((siteDiff) => (typeof siteDiff === 'undefined' ? [] : [siteDiff]));

    return {
        changedSites,
        hasChanges: changedSites.length > 0,
    };
}

export function detectConfigDrift(
    settings: ManagerRuntimeSettings,
    expectedBaseConfigHash: string,
    expectedRuntimeConfigHash: string,
): ConfigDriftStatus {
    const currentBaseConfigHash = hashContents(readFileSync(settings.paths.baseConfigFile, 'utf8'));
    const runtimeConfigExists = existsSync(settings.paths.runtimeConfigFile);
    const currentRuntimeConfigHash = runtimeConfigExists
        ? hashContents(readFileSync(settings.paths.runtimeConfigFile, 'utf8'))
        : undefined;

    return {
        baseConfigDrifted: currentBaseConfigHash !== expectedBaseConfigHash,
        currentBaseConfigHash,
        currentRuntimeConfigHash,
        expectedBaseConfigHash,
        expectedRuntimeConfigHash,
        runtimeConfigDrifted: currentRuntimeConfigHash !== expectedRuntimeConfigHash,
        runtimeConfigExists,
    };
}

export function loadManagedConfigForReconciliation(
    settings: ManagerRuntimeSettings,
    source: 'base' | 'runtime',
): { config: MagicSsoTomlConfig; filePath: string } {
    if (source === 'base') {
        return {
            config: loadBaseConfig(settings),
            filePath: settings.paths.baseConfigFile,
        };
    }

    if (!existsSync(settings.paths.runtimeConfigFile)) {
        throw new Error(
            `Managed runtime config file is missing: ${settings.paths.runtimeConfigFile}`,
        );
    }

    return {
        config: parseMagicSsoTomlConfig(
            readFileSync(settings.paths.runtimeConfigFile, 'utf8'),
            settings.paths.runtimeConfigFile,
        ),
        filePath: settings.paths.runtimeConfigFile,
    };
}

export function reconcileManagerStateFromConfig(
    state: ManagerState,
    settings: ManagerRuntimeSettings,
    config: MagicSsoTomlConfig,
    configFilePath: string,
): ManagerState {
    const normalizedState = normalizeManagerState(state);
    const seededState = createEmptyManagerState(settings.managedSiteIds);
    const configSitesById = new Map(config.sites.map((site) => [site.id, cloneSiteConfig(site)]));
    const managedSites = Object.fromEntries(
        settings.managedSiteIds.map((siteId): [string, ManagedSiteState] => {
            const siteConfig = configSitesById.get(siteId);
            if (typeof siteConfig === 'undefined') {
                throw new Error(`Managed site ${siteId} is missing from ${configFilePath}.`);
            }

            const existingSiteState =
                normalizedState.managedSites[siteId] ?? seededState.managedSites[siteId];
            if (typeof existingSiteState === 'undefined') {
                throw new Error(`Managed site ${siteId} is missing from manager state.`);
            }

            return [siteId, createManagedSiteStateFromSiteConfig(siteConfig, existingSiteState)];
        }),
    );

    return resetManagerStateApplyMetadata({
        version: normalizedState.version,
        managedSites,
        metadata: normalizedState.metadata,
    });
}
