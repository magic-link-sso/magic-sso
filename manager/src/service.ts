/**
 * manager/src/service.ts
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
import {
    FULL_ACCESS_SCOPE,
    parseMagicSsoTomlConfig,
    type MagicSsoTomlConfig,
} from '@magic-link-sso/config-core';
import { type ManagerAuditEvent } from './apply.js';
import { loadManagerAuditEvents } from './audit.js';
import { loadBaseConfig, selectManagedSites, type ManagedSiteBinding } from './baseConfig.js';
import {
    buildRuntimePlan,
    detectConfigDrift,
    loadManagedConfigForReconciliation,
    reconcileManagerStateFromConfig,
    summarizeManagedConfigDiff,
    type ConfigDriftStatus,
    type ManagedSiteDiffSummary,
    type RuntimePlan,
} from './runtime.js';
import { type ManagerRuntimeSettings } from './settings.js';
import {
    createManagerStateFromPortableSnapshot,
    createPortableManagerStateSnapshot,
    createEmptyManagerState,
    loadManagerState,
    normalizeManagerState,
    saveManagerState,
    type ManagedSiteState,
    type ManagerGrant,
    type ManagerState,
    type PortableManagerStateSnapshot,
} from './state.js';

export interface ManagedSiteSummary {
    allowedRedirectUris: string[];
    grantCount: number;
    id: string;
    origins: string[];
    scopeCount: number;
}

export interface ManagedSiteDetails extends ManagedSiteSummary {
    grants: ManagerGrant[];
    scopeCatalog: string[];
}

export interface ManagerDiffResult {
    diffSource: 'base' | 'runtime';
    driftStatus?: ConfigDriftStatus | undefined;
    runtimePlan: RuntimePlan;
    summary: ManagedSiteDiffSummary;
}

export interface ListManagerAuditEventsOptions {
    limit?: number | undefined;
}

export type ManagerReconcileSource = 'base' | 'runtime';

export interface ManagerStateMutationPreview {
    changedSiteIds: string[];
    diff: ManagedSiteDiffSummary;
    state: ManagerState;
}

export interface ManagerReconcilePreview extends ManagerStateMutationPreview {
    driftStatus?: ConfigDriftStatus | undefined;
    source: ManagerReconcileSource;
}

export interface ManagerReconcileStatusEntry {
    available: boolean;
    error?: string | undefined;
    preview?: ManagerReconcilePreview | undefined;
    source: ManagerReconcileSource;
}

export interface ManagerReconcileStatus {
    base: ManagerReconcileStatusEntry;
    driftStatus?: ConfigDriftStatus | undefined;
    runtime: ManagerReconcileStatusEntry;
}

function cloneSiteState(siteState: ManagedSiteState): ManagedSiteState {
    return structuredClone(siteState);
}

function createSeededState(settings: ManagerRuntimeSettings, state?: ManagerState): ManagerState {
    const normalizedState =
        typeof state === 'undefined'
            ? createEmptyManagerState(settings.managedSiteIds)
            : normalizeManagerState(state);
    const seededState = createEmptyManagerState(settings.managedSiteIds);

    return {
        version: normalizedState.version,
        metadata: { ...normalizedState.metadata },
        managedSites: Object.fromEntries(
            settings.managedSiteIds.map((siteId) => [
                siteId,
                cloneSiteState(
                    normalizedState.managedSites[siteId] ?? seededState.managedSites[siteId]!,
                ),
            ]),
        ),
    };
}

function getManagedBinding(
    state: ManagerState,
    settings: ManagerRuntimeSettings,
    siteId: string,
): ManagedSiteBinding {
    const baseConfig = loadBaseConfig(settings);
    const selection = selectManagedSites(baseConfig, state, settings);
    const managedBinding = selection.managedSites.find((site) => site.siteConfig.id === siteId);
    if (typeof managedBinding === 'undefined') {
        throw new Error(`Managed site ${siteId} is not available.`);
    }

    return managedBinding;
}

function ensureScopeCatalogContains(
    siteId: string,
    scopeCatalog: readonly string[],
    scopes: readonly string[],
): void {
    for (const scope of scopes) {
        if (scope === FULL_ACCESS_SCOPE) {
            continue;
        }

        if (!scopeCatalog.includes(scope)) {
            throw new Error(
                `Scope ${scope} is not in the catalog for ${siteId}. Add it first with scopes add.`,
            );
        }
    }
}

function formatSiteSummary(binding: ManagedSiteBinding): ManagedSiteSummary {
    return {
        allowedRedirectUris: [...binding.siteConfig.allowedRedirectUris],
        grantCount: binding.siteState.grants.length,
        id: binding.siteConfig.id,
        origins: [...binding.siteConfig.origins],
        scopeCount: binding.siteState.scopeCatalog.length,
    };
}

function getCurrentConfigForDiff(
    settings: ManagerRuntimeSettings,
    runtimePlan: RuntimePlan,
): { config: MagicSsoTomlConfig; source: 'base' | 'runtime' } {
    if (!existsSync(settings.paths.runtimeConfigFile)) {
        return {
            config: runtimePlan.baseConfig,
            source: 'base',
        };
    }

    return {
        config: parseMagicSsoTomlConfig(
            readFileSync(settings.paths.runtimeConfigFile, 'utf8'),
            settings.paths.runtimeConfigFile,
        ),
        source: 'runtime',
    };
}

function buildStateMutationPreview(
    currentState: ManagerState,
    nextState: ManagerState,
    settings: ManagerRuntimeSettings,
): ManagerStateMutationPreview {
    const nextRuntimePlan = buildRuntimePlan(nextState, settings);
    const currentConfig = getCurrentConfigForDiff(settings, nextRuntimePlan);
    const diff = summarizeManagedConfigDiff(
        currentConfig.config,
        nextRuntimePlan.runtimeConfig,
        settings.managedSiteIds,
    );

    return {
        changedSiteIds: diff.changedSites.map((site) => site.siteId),
        diff,
        state: nextState,
    };
}

function getDriftStatusFromState(
    state: ManagerState,
    settings: ManagerRuntimeSettings,
): ConfigDriftStatus | undefined {
    return typeof state.metadata.lastAppliedBaseConfigHash === 'string' &&
        typeof state.metadata.lastAppliedRuntimeConfigHash === 'string'
        ? detectConfigDrift(
              settings,
              state.metadata.lastAppliedBaseConfigHash,
              state.metadata.lastAppliedRuntimeConfigHash,
          )
        : undefined;
}

function assertSnapshotManagedSitesAreKnown(
    snapshot: PortableManagerStateSnapshot,
    settings: ManagerRuntimeSettings,
): void {
    for (const siteId of Object.keys(snapshot.managedSites)) {
        if (!settings.managedSiteIds.includes(siteId)) {
            throw new Error(`Portable manager state contains an unmanaged site: ${siteId}`);
        }
    }
}

export function loadManagerStateOrEmpty(settings: ManagerRuntimeSettings): ManagerState {
    return existsSync(settings.paths.stateFile)
        ? createSeededState(settings, loadManagerState(settings.paths.stateFile))
        : createEmptyManagerState(settings.managedSiteIds);
}

export function persistManagerState(
    settings: ManagerRuntimeSettings,
    state: ManagerState,
): ManagerState {
    const normalizedState = createSeededState(settings, state);
    saveManagerState(settings.paths.stateFile, normalizedState);
    return normalizedState;
}

export function listManagedSites(
    state: ManagerState,
    settings: ManagerRuntimeSettings,
): ManagedSiteSummary[] {
    const baseConfig = loadBaseConfig(settings);
    const selection = selectManagedSites(baseConfig, state, settings);
    return selection.managedSites.map((binding) => formatSiteSummary(binding));
}

export function getManagedSiteDetails(
    state: ManagerState,
    settings: ManagerRuntimeSettings,
    siteId: string,
): ManagedSiteDetails {
    const binding = getManagedBinding(state, settings, siteId);
    return {
        ...formatSiteSummary(binding),
        grants: structuredClone(binding.siteState.grants),
        scopeCatalog: [...binding.siteState.scopeCatalog],
    };
}

export function updateSiteGrant(
    state: ManagerState,
    settings: ManagerRuntimeSettings,
    siteId: string,
    email: string,
    scopes: readonly string[],
): ManagerState {
    const seededState = createSeededState(settings, state);
    const siteState = seededState.managedSites[siteId];
    if (typeof siteState === 'undefined') {
        throw new Error(`Managed site ${siteId} is not available.`);
    }

    ensureScopeCatalogContains(siteId, siteState.scopeCatalog, scopes);

    const remainingGrants = siteState.grants.filter(
        (grant) => grant.email !== email.trim().toLowerCase(),
    );
    siteState.grants = [
        ...remainingGrants,
        {
            email,
            scopes: [...scopes],
        },
    ];

    return normalizeManagerState(seededState);
}

export function replaceSiteGrants(
    state: ManagerState,
    settings: ManagerRuntimeSettings,
    siteId: string,
    grants: readonly ManagerGrant[],
): ManagerState {
    const seededState = createSeededState(settings, state);
    const siteState = seededState.managedSites[siteId];
    if (typeof siteState === 'undefined') {
        throw new Error(`Managed site ${siteId} is not available.`);
    }

    for (const grant of grants) {
        ensureScopeCatalogContains(siteId, siteState.scopeCatalog, grant.scopes);
    }

    siteState.grants = grants.map((grant) => ({
        email: grant.email,
        scopes: [...grant.scopes],
    }));

    return normalizeManagerState(seededState);
}

export function revokeSiteGrant(
    state: ManagerState,
    settings: ManagerRuntimeSettings,
    siteId: string,
    email: string,
): ManagerState {
    const seededState = createSeededState(settings, state);
    const siteState = seededState.managedSites[siteId];
    if (typeof siteState === 'undefined') {
        throw new Error(`Managed site ${siteId} is not available.`);
    }

    const normalizedEmail = email.trim().toLowerCase();
    const nextGrants = siteState.grants.filter((grant) => grant.email !== normalizedEmail);
    if (nextGrants.length === siteState.grants.length) {
        throw new Error(`Grant for ${normalizedEmail} does not exist on ${siteId}.`);
    }

    siteState.grants = nextGrants;
    return normalizeManagerState(seededState);
}

export function addSiteScope(
    state: ManagerState,
    settings: ManagerRuntimeSettings,
    siteId: string,
    scope: string,
): ManagerState {
    const seededState = createSeededState(settings, state);
    const siteState = seededState.managedSites[siteId];
    if (typeof siteState === 'undefined') {
        throw new Error(`Managed site ${siteId} is not available.`);
    }

    siteState.scopeCatalog = [...siteState.scopeCatalog, scope];
    return normalizeManagerState(seededState);
}

export function replaceSiteScopes(
    state: ManagerState,
    settings: ManagerRuntimeSettings,
    siteId: string,
    scopes: readonly string[],
): ManagerState {
    const seededState = createSeededState(settings, state);
    const siteState = seededState.managedSites[siteId];
    if (typeof siteState === 'undefined') {
        throw new Error(`Managed site ${siteId} is not available.`);
    }

    siteState.scopeCatalog = [...scopes];
    const normalizedState = normalizeManagerState(seededState);
    const normalizedSiteState = normalizedState.managedSites[siteId];
    if (typeof normalizedSiteState === 'undefined') {
        throw new Error(`Managed site ${siteId} is not available.`);
    }

    for (const grant of normalizedSiteState.grants) {
        ensureScopeCatalogContains(siteId, normalizedSiteState.scopeCatalog, grant.scopes);
    }

    return normalizedState;
}

export function removeSiteScope(
    state: ManagerState,
    settings: ManagerRuntimeSettings,
    siteId: string,
    scope: string,
): ManagerState {
    const seededState = createSeededState(settings, state);
    const siteState = seededState.managedSites[siteId];
    if (typeof siteState === 'undefined') {
        throw new Error(`Managed site ${siteId} is not available.`);
    }

    const normalizedScope = scope.trim();
    const scopeInUse = siteState.grants.some((grant) => grant.scopes.includes(normalizedScope));
    if (scopeInUse) {
        throw new Error(`Scope ${normalizedScope} is still assigned on ${siteId}.`);
    }

    const nextScopeCatalog = siteState.scopeCatalog.filter(
        (catalogScope) => catalogScope !== normalizedScope,
    );
    if (nextScopeCatalog.length === siteState.scopeCatalog.length) {
        throw new Error(`Scope ${normalizedScope} does not exist on ${siteId}.`);
    }

    siteState.scopeCatalog = nextScopeCatalog;
    return normalizeManagerState(seededState);
}

export function buildManagerDiff(
    state: ManagerState,
    settings: ManagerRuntimeSettings,
): ManagerDiffResult {
    const runtimePlan = buildRuntimePlan(state, settings);
    const currentConfig = getCurrentConfigForDiff(settings, runtimePlan);
    const driftStatus =
        typeof state.metadata.lastAppliedBaseConfigHash === 'string' &&
        typeof state.metadata.lastAppliedRuntimeConfigHash === 'string'
            ? detectConfigDrift(
                  settings,
                  state.metadata.lastAppliedBaseConfigHash,
                  state.metadata.lastAppliedRuntimeConfigHash,
              )
            : undefined;

    return {
        diffSource: currentConfig.source,
        driftStatus,
        runtimePlan,
        summary: summarizeManagedConfigDiff(
            currentConfig.config,
            runtimePlan.runtimeConfig,
            settings.managedSiteIds,
        ),
    };
}

export function exportPortableManagerStateSnapshot(
    state: ManagerState,
): PortableManagerStateSnapshot {
    return createPortableManagerStateSnapshot(state);
}

export function previewPortableManagerStateImport(
    state: ManagerState,
    settings: ManagerRuntimeSettings,
    snapshot: PortableManagerStateSnapshot,
): ManagerStateMutationPreview {
    assertSnapshotManagedSitesAreKnown(snapshot, settings);
    const importedState = createSeededState(
        settings,
        createManagerStateFromPortableSnapshot(snapshot),
    );
    return buildStateMutationPreview(state, importedState, settings);
}

export function buildManagerReconcilePreview(
    state: ManagerState,
    settings: ManagerRuntimeSettings,
    source: ManagerReconcileSource,
): ManagerReconcilePreview {
    const { config, filePath } = loadManagedConfigForReconciliation(settings, source);
    const reconciledState = createSeededState(
        settings,
        reconcileManagerStateFromConfig(state, settings, config, filePath),
    );
    const preview = buildStateMutationPreview(state, reconciledState, settings);

    return {
        ...preview,
        driftStatus: getDriftStatusFromState(state, settings),
        source,
    };
}

export function buildManagerReconcileStatus(
    state: ManagerState,
    settings: ManagerRuntimeSettings,
): ManagerReconcileStatus {
    const driftStatus = getDriftStatusFromState(state, settings);
    const buildEntry = (source: ManagerReconcileSource): ManagerReconcileStatusEntry => {
        try {
            return {
                available: true,
                preview: buildManagerReconcilePreview(state, settings, source),
                source,
            };
        } catch (error) {
            return {
                available: false,
                error: error instanceof Error ? error.message : String(error),
                source,
            };
        }
    };

    return {
        base: buildEntry('base'),
        driftStatus,
        runtime: buildEntry('runtime'),
    };
}

export function listManagerAuditEvents(
    settings: ManagerRuntimeSettings,
    options: ListManagerAuditEventsOptions = {},
): ManagerAuditEvent[] {
    return loadManagerAuditEvents(settings, options.limit);
}
