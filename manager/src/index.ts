/**
 * manager/src/index.ts
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

export { buildApp, type BuildAppOptions } from './app.js';
export {
    loadBaseConfig,
    selectManagedSites,
    type ManagedSiteBinding,
    type ManagedSiteSelection,
} from './baseConfig.js';
export {
    authenticateApiRequest,
    authenticateGateRequest,
    authenticateManagerRequest,
    extractBearerToken,
    isBearerTokenAuthConfig,
    isGateHeaderAuthConfig,
    type ManagerApiActor,
    type ManagerAuthenticatedActor,
    type ManagerGateActor,
} from './auth.js';
export {
    buildRuntimePlan,
    detectConfigDrift,
    loadManagedConfigForReconciliation,
    reconcileManagerStateFromConfig,
    summarizeManagedConfigDiff,
    validateRuntimeToml,
    type ConfigDriftStatus,
    type ManagedSiteDiff,
    type ManagedSiteDiffSummary,
    type RuntimePlan,
} from './runtime.js';
export {
    applyManagerState,
    reloadManagerRuntime,
    type ApplyManagerStateOptions,
    type ApplyManagerStateResult,
    type ManagerAuditActor,
    type ManagerAuditEvent,
    type ManagerAuditEventKind,
    type ManagerReloadResult,
    type ReloadManagerRuntimeOptions,
} from './apply.js';
export {
    appendManagerAuditEvent,
    loadManagerAuditEvents,
    recordManagerMutationAuditEvent,
    type RecordManagerMutationAuditEventOptions,
} from './audit.js';
export { writeTextFileAtomically } from './files.js';
export {
    MANAGER_CONFIG_FILE_ENV_VAR_NAME,
    assertManagerAuditConfig,
    loadManagerRuntimeSettings,
    parseManagerRuntimeSettingsToml,
    type ManagerAuditConfig,
    type ManagerBearerTokenAuthConfig,
    type ManagerGateHeaderAuthConfig,
    type ManagerPaths,
    type ManagerReloadTarget,
    type ManagerRuntimeSettings,
    type ManagerServiceAuthConfig,
    type ManagerServiceConfig,
} from './settings.js';
export {
    buildManagerReconcilePreview,
    buildManagerReconcileStatus,
    addSiteScope,
    buildManagerDiff,
    exportPortableManagerStateSnapshot,
    getManagedSiteDetails,
    listManagedSites,
    listManagerAuditEvents,
    loadManagerStateOrEmpty,
    persistManagerState,
    previewPortableManagerStateImport,
    replaceSiteGrants,
    replaceSiteScopes,
    removeSiteScope,
    revokeSiteGrant,
    updateSiteGrant,
    type ManagerReconcilePreview,
    type ManagerReconcileSource,
    type ManagerReconcileStatus,
    type ManagerReconcileStatusEntry,
    type ManagerStateMutationPreview,
    type ManagedSiteDetails,
    type ManagedSiteSummary,
    type ListManagerAuditEventsOptions,
    type ManagerDiffResult,
} from './service.js';
export {
    MANAGER_STATE_VERSION,
    createManagerStateFromPortableSnapshot,
    createEmptyManagerState,
    createPortableManagerStateSnapshot,
    loadManagerState,
    normalizeManagerState,
    normalizePortableManagerStateSnapshot,
    parseManagerStateJson,
    parsePortableManagerStateSnapshotJson,
    resetManagerStateApplyMetadata,
    saveManagerState,
    stringifyManagerState,
    stringifyPortableManagerStateSnapshot,
    type ManagedSiteState,
    type ManagerGrant,
    type ManagerState,
    type ManagerStateMetadata,
    type PortableManagerStateSnapshot,
} from './state.js';
