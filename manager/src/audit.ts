/**
 * manager/src/audit.ts
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

import { appendFileSync, existsSync, readFileSync, renameSync, rmSync, statSync } from 'node:fs';
import { createHash, createHmac, randomUUID } from 'node:crypto';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { z } from 'zod';
import { type ManagerAuditActor, type ManagerAuditEvent } from './apply.js';
import { buildRuntimePlan, detectConfigDrift } from './runtime.js';
import { assertManagerAuditConfig, type ManagerRuntimeSettings } from './settings.js';
import { normalizeManagerState, stringifyManagerState, type ManagerState } from './state.js';

const mutationAuditKinds = [
    'access-replaced',
    'grant-revoked',
    'grant-saved',
    'scope-added',
    'scope-catalog-replaced',
    'scope-removed',
    'state-imported',
    'state-reconciled',
] as const;

type ManagerMutationAuditKind = (typeof mutationAuditKinds)[number];

const managerMutationAuditKindSchema = z.enum(mutationAuditKinds);

const configDriftStatusSchema = z
    .object({
        baseConfigDrifted: z.boolean(),
        currentBaseConfigHash: z.string(),
        currentRuntimeConfigHash: z.union([z.string(), z.undefined()]),
        expectedBaseConfigHash: z.string(),
        expectedRuntimeConfigHash: z.string(),
        runtimeConfigDrifted: z.boolean(),
        runtimeConfigExists: z.boolean(),
    })
    .strict();

const managerAuditEventSchema = z
    .object({
        actor: z
            .object({
                host: z.string(),
                siteId: z.string().optional(),
                user: z.string(),
            })
            .strict(),
        baseConfigHash: z.string(),
        changedSiteIds: z.array(z.string()),
        driftStatus: configDriftStatusSchema.optional(),
        id: z.string(),
        kind: z.union([
            z.literal('apply-failed'),
            z.literal('apply-succeeded'),
            managerMutationAuditKindSchema,
        ]),
        message: z.string(),
        reloaded: z.boolean(),
        rolledBack: z.boolean(),
        runtimeConfigHash: z.string(),
        stateHash: z.string(),
        timestamp: z.string(),
    })
    .strict();

const AUDIT_HMAC_ALGORITHM = 'hmac-sha256-v1';

const managerAuditIntegritySchema = z
    .object({
        algorithm: z.literal(AUDIT_HMAC_ALGORITHM),
        entryHash: z.string().regex(/^[0-9a-f]{64}$/),
        previousHash: z
            .string()
            .regex(/^[0-9a-f]{64}$/)
            .optional(),
    })
    .strict();

const persistedManagerAuditEventSchema = managerAuditEventSchema
    .extend({
        integrity: managerAuditIntegritySchema.optional(),
    })
    .strict();

type PersistedManagerAuditEvent = ManagerAuditEvent & {
    integrity?: z.infer<typeof managerAuditIntegritySchema> | undefined;
};

export interface RecordManagerMutationAuditEventOptions {
    actor: ManagerAuditActor;
    changedSiteIds: string[];
    kind: ManagerMutationAuditKind;
    message: string;
    now?: Date | undefined;
}

function ensureParentDirectory(filePath: string): void {
    mkdirSync(dirname(filePath), { recursive: true });
}

function hashContents(value: string): string {
    return createHash('sha256').update(value).digest('hex');
}

function getArchivedAuditFilePath(auditFilePath: string, archiveNumber: number): string {
    return `${auditFilePath}.${archiveNumber}`;
}

function getAuditFilePathsOldestFirst(auditFilePath: string, maxArchivedFiles: number): string[] {
    const archivedFiles: string[] = [];
    for (let archiveNumber = maxArchivedFiles; archiveNumber >= 1; archiveNumber -= 1) {
        const archivedFilePath = getArchivedAuditFilePath(auditFilePath, archiveNumber);
        if (existsSync(archivedFilePath)) {
            archivedFiles.push(archivedFilePath);
        }
    }

    if (existsSync(auditFilePath)) {
        archivedFiles.push(auditFilePath);
    }

    return archivedFiles;
}

function serializeAuditEventPayload(event: ManagerAuditEvent): string {
    return JSON.stringify({
        actor: event.actor,
        baseConfigHash: event.baseConfigHash,
        changedSiteIds: event.changedSiteIds,
        driftStatus: event.driftStatus,
        id: event.id,
        kind: event.kind,
        message: event.message,
        reloaded: event.reloaded,
        rolledBack: event.rolledBack,
        runtimeConfigHash: event.runtimeConfigHash,
        stateHash: event.stateHash,
        timestamp: event.timestamp,
    });
}

function computeAuditEntryHash(
    event: ManagerAuditEvent,
    integrityKey: string,
    previousHash: string | undefined,
): string {
    const hmac = createHmac('sha256', integrityKey);
    hmac.update(serializeAuditEventPayload(event), 'utf8');
    hmac.update('\n', 'utf8');
    hmac.update(previousHash ?? '', 'utf8');
    return hmac.digest('hex');
}

function parseAuditFileEvents(auditFilePath: string): PersistedManagerAuditEvent[] {
    const eventLines = readFileSync(auditFilePath, 'utf8')
        .split('\n')
        .map((line) => line.trim())
        .filter((line) => line.length > 0);

    return eventLines.map((line, index): PersistedManagerAuditEvent => {
        let parsedValue: unknown;
        try {
            parsedValue = JSON.parse(line);
        } catch {
            throw new Error(`Invalid manager audit event JSON at line ${index + 1}.`);
        }

        return persistedManagerAuditEventSchema.parse(parsedValue);
    });
}

function rotateAuditFiles(auditFilePath: string, maxArchivedFiles: number): void {
    const oldestArchivePath = getArchivedAuditFilePath(auditFilePath, maxArchivedFiles);
    rmSync(oldestArchivePath, { force: true });

    for (let archiveNumber = maxArchivedFiles - 1; archiveNumber >= 1; archiveNumber -= 1) {
        const currentArchivePath = getArchivedAuditFilePath(auditFilePath, archiveNumber);
        if (!existsSync(currentArchivePath)) {
            continue;
        }

        renameSync(currentArchivePath, getArchivedAuditFilePath(auditFilePath, archiveNumber + 1));
    }

    if (existsSync(auditFilePath)) {
        renameSync(auditFilePath, getArchivedAuditFilePath(auditFilePath, 1));
    }
}

function getLatestSignedEntryHash(settings: ManagerRuntimeSettings): string | undefined {
    assertManagerAuditConfig(settings);

    const auditFilePaths = getAuditFilePathsOldestFirst(
        settings.paths.auditFile,
        settings.audit.maxArchivedFiles,
    );
    for (let fileIndex = auditFilePaths.length - 1; fileIndex >= 0; fileIndex -= 1) {
        const filePath = auditFilePaths[fileIndex];
        if (typeof filePath !== 'string') {
            continue;
        }

        const events = parseAuditFileEvents(filePath);
        const latestEvent = events.at(-1);
        if (typeof latestEvent?.integrity?.entryHash === 'string') {
            return latestEvent.integrity.entryHash;
        }
    }

    return undefined;
}

function activeAuditFileContainsLegacyEvents(auditFilePath: string): boolean {
    if (!existsSync(auditFilePath)) {
        return false;
    }

    const events = parseAuditFileEvents(auditFilePath);
    return events.some((event) => typeof event.integrity === 'undefined');
}

function shouldRotateAuditFile(
    auditFilePath: string,
    maxFileBytes: number,
    nextEntryLine: string,
): boolean {
    if (!existsSync(auditFilePath)) {
        return false;
    }

    return statSync(auditFilePath).size + Buffer.byteLength(nextEntryLine, 'utf8') > maxFileBytes;
}

function signAuditEvent(
    settings: ManagerRuntimeSettings,
    event: ManagerAuditEvent,
    previousHash: string | undefined,
): PersistedManagerAuditEvent {
    assertManagerAuditConfig(settings);

    return {
        ...event,
        integrity: {
            algorithm: AUDIT_HMAC_ALGORITHM,
            entryHash: computeAuditEntryHash(event, settings.audit.integrityKey, previousHash),
            previousHash,
        },
    };
}

function verifySignedAuditEvent(
    settings: ManagerRuntimeSettings,
    event: PersistedManagerAuditEvent,
    previousSignedEntryHash: string | undefined,
): string | undefined {
    if (typeof event.integrity === 'undefined') {
        return previousSignedEntryHash;
    }

    assertManagerAuditConfig(settings);
    if (
        typeof previousSignedEntryHash === 'string' &&
        event.integrity.previousHash !== previousSignedEntryHash
    ) {
        throw new Error(`Manager audit integrity chain is broken at event ${event.id}.`);
    }

    const expectedEntryHash = computeAuditEntryHash(
        event,
        settings.audit.integrityKey,
        event.integrity.previousHash,
    );
    if (event.integrity.entryHash !== expectedEntryHash) {
        throw new Error(`Manager audit integrity verification failed for event ${event.id}.`);
    }

    return event.integrity.entryHash;
}

function stripAuditIntegrity(event: PersistedManagerAuditEvent): ManagerAuditEvent {
    const { integrity: _integrity, ...auditEvent } = event;
    return managerAuditEventSchema.parse(auditEvent);
}

function hashManagerState(state: ManagerState): string {
    const normalizedState = normalizeManagerState(state);
    return hashContents(
        stringifyManagerState({
            ...normalizedState,
            metadata: {},
        }),
    );
}

function getCurrentDriftStatus(
    state: ManagerState,
    settings: ManagerRuntimeSettings,
): ManagerAuditEvent['driftStatus'] {
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

export function appendManagerAuditEvent(
    settings: ManagerRuntimeSettings,
    event: ManagerAuditEvent,
): boolean {
    try {
        assertManagerAuditConfig(settings);
        ensureParentDirectory(settings.paths.auditFile);

        let previousHash = getLatestSignedEntryHash(settings);
        if (activeAuditFileContainsLegacyEvents(settings.paths.auditFile)) {
            rotateAuditFiles(settings.paths.auditFile, settings.audit.maxArchivedFiles);
            previousHash = undefined;
        }

        const persistedEvent = signAuditEvent(settings, event, previousHash);
        const nextEntryLine = `${JSON.stringify(persistedEvent)}\n`;
        if (
            shouldRotateAuditFile(
                settings.paths.auditFile,
                settings.audit.maxFileBytes,
                nextEntryLine,
            )
        ) {
            rotateAuditFiles(settings.paths.auditFile, settings.audit.maxArchivedFiles);
        }

        appendFileSync(settings.paths.auditFile, nextEntryLine, 'utf8');
        return true;
    } catch {
        return false;
    }
}

export function recordManagerMutationAuditEvent(
    state: ManagerState,
    settings: ManagerRuntimeSettings,
    options: RecordManagerMutationAuditEventOptions,
): { event: ManagerAuditEvent; persisted: boolean } {
    const stateHash = hashManagerState(state);
    let baseConfigHash: string;
    let runtimeConfigHash: string;
    try {
        const runtimePlan = buildRuntimePlan(state, settings);
        baseConfigHash = runtimePlan.baseConfigHash;
        runtimeConfigHash = runtimePlan.runtimeConfigHash;
    } catch {
        baseConfigHash = hashContents(readFileSync(settings.paths.baseConfigFile, 'utf8'));
        runtimeConfigHash = hashContents(
            `pending-managed-state:${settings.paths.runtimeConfigFile}:${stateHash}`,
        );
    }

    const event: ManagerAuditEvent = {
        actor: options.actor,
        baseConfigHash,
        changedSiteIds: [...new Set(options.changedSiteIds)].sort((left, right) =>
            left.localeCompare(right),
        ),
        driftStatus: getCurrentDriftStatus(state, settings),
        id: randomUUID(),
        kind: options.kind,
        message: options.message,
        reloaded: false,
        rolledBack: false,
        runtimeConfigHash,
        stateHash,
        timestamp: (options.now ?? new Date()).toISOString(),
    };

    return {
        event,
        persisted: appendManagerAuditEvent(settings, event),
    };
}

export function loadManagerAuditEvents(
    settings: ManagerRuntimeSettings,
    limit?: number | undefined,
): ManagerAuditEvent[] {
    assertManagerAuditConfig(settings);

    const auditFilePaths = getAuditFilePathsOldestFirst(
        settings.paths.auditFile,
        settings.audit.maxArchivedFiles,
    );
    if (auditFilePaths.length === 0) {
        return [];
    }

    const events: ManagerAuditEvent[] = [];
    let previousSignedEntryHash: string | undefined;
    for (const auditFilePath of auditFilePaths) {
        const persistedEvents = parseAuditFileEvents(auditFilePath);
        for (const persistedEvent of persistedEvents) {
            previousSignedEntryHash = verifySignedAuditEvent(
                settings,
                persistedEvent,
                previousSignedEntryHash,
            );
            events.push(stripAuditIntegrity(persistedEvent));
        }
    }

    const newestFirstEvents = [...events].reverse();
    return typeof limit === 'number' ? newestFirstEvents.slice(0, limit) : newestFirstEvents;
}
