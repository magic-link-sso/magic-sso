/**
 * manager/src/apply.ts
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

import {
    closeSync,
    existsSync,
    fsyncSync,
    mkdirSync,
    openSync,
    readFileSync,
    unlinkSync,
    writeFileSync,
} from 'node:fs';
import { createHash, randomUUID } from 'node:crypto';
import { hostname, userInfo } from 'node:os';
import { dirname } from 'node:path';
import { z } from 'zod';
import { appendManagerAuditEvent } from './audit.js';
import { writeTextFileAtomically } from './files.js';
import {
    buildRuntimePlan,
    detectConfigDrift,
    type ConfigDriftStatus,
    type RuntimePlan,
} from './runtime.js';
import { type ManagerRuntimeSettings, type ManagerReloadTarget } from './settings.js';
import { normalizeManagerState, stringifyManagerState, type ManagerState } from './state.js';

const reloadResponseSchema = z
    .object({
        changedSiteIds: z.array(z.string()).default([]),
        reloaded: z.literal(true),
    })
    .strict();

export interface ManagerAuditActor {
    host: string;
    siteId?: string | undefined;
    user: string;
}

export type ManagerAuditEventKind =
    | 'access-replaced'
    | 'apply-failed'
    | 'apply-succeeded'
    | 'grant-revoked'
    | 'grant-saved'
    | 'state-imported'
    | 'state-reconciled'
    | 'scope-added'
    | 'scope-catalog-replaced'
    | 'scope-removed';

export interface ManagerReloadResult {
    changedSiteIds: string[];
    reloaded: true;
}

export interface ManagerAuditEvent {
    actor: ManagerAuditActor;
    baseConfigHash: string;
    changedSiteIds: string[];
    driftStatus?: ConfigDriftStatus | undefined;
    id: string;
    kind: ManagerAuditEventKind;
    message: string;
    reloaded: boolean;
    rolledBack: boolean;
    runtimeConfigHash: string;
    stateHash: string;
    timestamp: string;
}

export interface ApplyManagerStateOptions {
    actor?: ManagerAuditActor | undefined;
    fetchImplementation?: typeof fetch | undefined;
    now?: Date | undefined;
}

export interface ReloadManagerRuntimeOptions {
    fetchImplementation?: typeof fetch | undefined;
}

export interface ApplyManagerStateResult {
    auditEvent: ManagerAuditEvent;
    auditPersisted: boolean;
    driftStatus?: ConfigDriftStatus | undefined;
    reloadResult?: ManagerReloadResult | undefined;
    runtimePlan: RuntimePlan;
    updatedState: ManagerState;
}

interface LockHandle {
    release: () => void;
}

function hashContents(value: string): string {
    return createHash('sha256').update(value).digest('hex');
}

function getCurrentActorIdentity(): ManagerAuditActor {
    return {
        host: hostname(),
        user: userInfo().username,
    };
}

function hashManagerStateForApply(state: ManagerState): string {
    const normalizedState = normalizeManagerState(state);
    return hashContents(
        stringifyManagerState({
            ...normalizedState,
            metadata: {},
        }),
    );
}

function ensureParentDirectory(filePath: string): void {
    mkdirSync(dirname(filePath), { recursive: true });
}

function removeFileIfExists(filePath: string): void {
    if (existsSync(filePath)) {
        unlinkSync(filePath);
    }
}

function isProcessAlive(pid: number): boolean {
    try {
        process.kill(pid, 0);
        return true;
    } catch (error) {
        if (typeof error === 'object' && error !== null && Reflect.get(error, 'code') === 'EPERM') {
            return true;
        }

        return false;
    }
}

function shouldRecoverStaleApplyLock(lockFilePath: string): boolean {
    if (!existsSync(lockFilePath)) {
        return false;
    }

    let parsedLockContents: unknown;
    try {
        parsedLockContents = JSON.parse(readFileSync(lockFilePath, 'utf8').trim());
    } catch {
        return false;
    }

    if (typeof parsedLockContents !== 'object' || parsedLockContents === null) {
        return false;
    }

    const pid = Reflect.get(parsedLockContents, 'pid');
    return typeof pid === 'number' && Number.isInteger(pid) && pid > 0 && !isProcessAlive(pid);
}

function acquireApplyLock(lockFilePath: string): LockHandle {
    ensureParentDirectory(lockFilePath);

    let fileDescriptor: number;
    try {
        fileDescriptor = openSync(lockFilePath, 'wx');
    } catch (error) {
        if (
            typeof error === 'object' &&
            error !== null &&
            Reflect.get(error, 'code') === 'EEXIST'
        ) {
            if (shouldRecoverStaleApplyLock(lockFilePath)) {
                removeFileIfExists(lockFilePath);
                return acquireApplyLock(lockFilePath);
            }

            throw new Error(`Another manager apply is already in progress: ${lockFilePath}`);
        }

        throw error;
    }

    try {
        writeFileSync(
            fileDescriptor,
            `${JSON.stringify({ pid: process.pid, startedAt: new Date().toISOString() })}\n`,
            'utf8',
        );
        fsyncSync(fileDescriptor);
    } finally {
        closeSync(fileDescriptor);
    }

    return {
        release: () => {
            removeFileIfExists(lockFilePath);
        },
    };
}

async function requestServerReload(
    reloadTarget: ManagerReloadTarget,
    fetchImplementation: typeof fetch,
): Promise<ManagerReloadResult> {
    let response: Response;
    try {
        response = await fetchImplementation(reloadTarget.url, {
            method: 'POST',
            headers: {
                'x-magic-sso-reload-secret': reloadTarget.secret,
            },
            signal: AbortSignal.timeout(reloadTarget.timeoutMs),
        });
    } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        throw new Error(`Failed to reach the server reload endpoint: ${message}`);
    }

    const responseText = await response.text();
    const responseBody =
        responseText.trim().length === 0 ? undefined : safelyParseJson(responseText);

    if (!response.ok) {
        const responseMessage =
            typeof responseBody === 'object' &&
            responseBody !== null &&
            typeof Reflect.get(responseBody, 'message') === 'string'
                ? String(Reflect.get(responseBody, 'message'))
                : `HTTP ${response.status}`;
        throw new Error(`Server reload failed: ${responseMessage}`);
    }

    const parsedResponse = reloadResponseSchema.safeParse(responseBody);
    if (!parsedResponse.success) {
        throw new Error('Server reload returned an unexpected response body.');
    }

    return parsedResponse.data;
}

export async function reloadManagerRuntime(
    settings: ManagerRuntimeSettings,
    options: ReloadManagerRuntimeOptions = {},
): Promise<ManagerReloadResult> {
    if (typeof settings.reload === 'undefined') {
        throw new Error(
            'Manager reload target is not configured. Add [reload] to MAGICSSO_MANAGER_CONFIG_FILE.',
        );
    }

    return requestServerReload(settings.reload, options.fetchImplementation ?? fetch);
}

function safelyParseJson(value: string): unknown {
    try {
        return JSON.parse(value);
    } catch {
        return undefined;
    }
}

function createBaseDriftError(): Error {
    return new Error(
        'Base config drift detected. Reconcile magic-sso.base.toml before running apply again.',
    );
}

function createFailureAuditEvent(
    actor: ManagerAuditActor,
    runtimePlan: RuntimePlan,
    stateHash: string,
    timestamp: string,
    message: string,
    rolledBack: boolean,
    driftStatus?: ConfigDriftStatus | undefined,
): ManagerAuditEvent {
    return {
        actor,
        baseConfigHash: runtimePlan.baseConfigHash,
        changedSiteIds: [],
        driftStatus,
        id: randomUUID(),
        kind: 'apply-failed',
        message,
        reloaded: false,
        rolledBack,
        runtimeConfigHash: runtimePlan.runtimeConfigHash,
        stateHash,
        timestamp,
    };
}

function createSuccessAuditEvent(
    actor: ManagerAuditActor,
    runtimePlan: RuntimePlan,
    stateHash: string,
    timestamp: string,
    changedSiteIds: string[],
    reloaded: boolean,
    driftStatus?: ConfigDriftStatus | undefined,
): ManagerAuditEvent {
    return {
        actor,
        baseConfigHash: runtimePlan.baseConfigHash,
        changedSiteIds,
        driftStatus,
        id: randomUUID(),
        kind: 'apply-succeeded',
        message: reloaded
            ? 'Applied runtime config and reloaded the server.'
            : 'Applied runtime config without requesting a server reload.',
        reloaded,
        rolledBack: false,
        runtimeConfigHash: runtimePlan.runtimeConfigHash,
        stateHash,
        timestamp,
    };
}

function getDriftStatus(
    state: ManagerState,
    settings: ManagerRuntimeSettings,
): ConfigDriftStatus | undefined {
    const expectedBaseConfigHash = state.metadata.lastAppliedBaseConfigHash;
    const expectedRuntimeConfigHash = state.metadata.lastAppliedRuntimeConfigHash;

    if (
        typeof expectedBaseConfigHash !== 'string' ||
        typeof expectedRuntimeConfigHash !== 'string'
    ) {
        return undefined;
    }

    return detectConfigDrift(settings, expectedBaseConfigHash, expectedRuntimeConfigHash);
}

function createUpdatedState(
    state: ManagerState,
    timestamp: string,
    runtimePlan: RuntimePlan,
    stateHash: string,
): ManagerState {
    const normalizedState = normalizeManagerState(state);
    return {
        ...normalizedState,
        metadata: {
            ...normalizedState.metadata,
            lastAppliedAt: timestamp,
            lastAppliedBaseConfigHash: runtimePlan.baseConfigHash,
            lastAppliedRuntimeConfigHash: runtimePlan.runtimeConfigHash,
            lastAppliedStateHash: stateHash,
        },
    };
}

export async function applyManagerState(
    state: ManagerState,
    settings: ManagerRuntimeSettings,
    options: ApplyManagerStateOptions = {},
): Promise<ApplyManagerStateResult> {
    const lockHandle = acquireApplyLock(settings.paths.lockFile);
    try {
        const actor = options.actor ?? getCurrentActorIdentity();
        const timestamp = (options.now ?? new Date()).toISOString();
        const stateHash = hashManagerStateForApply(state);
        const runtimePlan = buildRuntimePlan(state, settings);
        const driftStatus = getDriftStatus(state, settings);
        if (driftStatus?.baseConfigDrifted) {
            const auditEvent = createFailureAuditEvent(
                actor,
                runtimePlan,
                stateHash,
                timestamp,
                createBaseDriftError().message,
                false,
                driftStatus,
            );
            appendManagerAuditEvent(settings, auditEvent);
            throw createBaseDriftError();
        }

        const hadRuntimeConfig = existsSync(settings.paths.runtimeConfigFile);
        const previousRuntimeToml = hadRuntimeConfig
            ? readFileSync(settings.paths.runtimeConfigFile, 'utf8')
            : undefined;
        const hadLastKnownGoodRuntime = existsSync(settings.paths.lastGoodRuntimeConfigFile);
        const previousLastKnownGoodRuntimeToml = hadLastKnownGoodRuntime
            ? readFileSync(settings.paths.lastGoodRuntimeConfigFile, 'utf8')
            : undefined;
        const rollbackRuntimeToml = previousRuntimeToml ?? previousLastKnownGoodRuntimeToml;

        if (typeof rollbackRuntimeToml === 'string') {
            writeTextFileAtomically(settings.paths.lastGoodRuntimeConfigFile, rollbackRuntimeToml);
        }

        writeTextFileAtomically(settings.paths.runtimeConfigFile, runtimePlan.runtimeToml);

        let reloadResult: ManagerReloadResult | undefined;
        if (typeof settings.reload !== 'undefined') {
            try {
                reloadResult = await requestServerReload(
                    settings.reload,
                    options.fetchImplementation ?? fetch,
                );
            } catch (error) {
                if (typeof rollbackRuntimeToml === 'string') {
                    writeTextFileAtomically(settings.paths.runtimeConfigFile, rollbackRuntimeToml);
                } else {
                    removeFileIfExists(settings.paths.runtimeConfigFile);
                }

                const message =
                    error instanceof Error ? error.message : 'Server reload failed after apply.';
                const auditEvent = createFailureAuditEvent(
                    actor,
                    runtimePlan,
                    stateHash,
                    timestamp,
                    message,
                    true,
                    driftStatus,
                );
                appendManagerAuditEvent(settings, auditEvent);
                throw new Error(message);
            }
        }

        writeTextFileAtomically(settings.paths.lastGoodRuntimeConfigFile, runtimePlan.runtimeToml);

        const updatedState = createUpdatedState(state, timestamp, runtimePlan, stateHash);
        writeTextFileAtomically(settings.paths.stateFile, stringifyManagerState(updatedState));

        const changedSiteIds =
            typeof reloadResult === 'undefined' ? [] : reloadResult.changedSiteIds;
        const auditEvent = createSuccessAuditEvent(
            actor,
            runtimePlan,
            stateHash,
            timestamp,
            changedSiteIds,
            typeof reloadResult !== 'undefined',
            driftStatus,
        );
        const auditPersisted = appendManagerAuditEvent(settings, auditEvent);

        return {
            auditEvent,
            auditPersisted,
            driftStatus,
            reloadResult,
            runtimePlan,
            updatedState,
        };
    } finally {
        lockHandle.release();
    }
}
