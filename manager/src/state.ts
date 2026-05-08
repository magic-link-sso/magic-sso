/**
 * manager/src/state.ts
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
import { FULL_ACCESS_SCOPE } from '@magic-link-sso/config-core';
import { z } from 'zod';
import { writeTextFileAtomically } from './files.js';

export const MANAGER_STATE_VERSION = 1;

export interface ManagerGrant {
    email: string;
    scopes: string[];
}

export interface ManagedSiteState {
    grants: ManagerGrant[];
    scopeCatalog: string[];
}

export interface ManagerStateMetadata {
    lastAppliedAt?: string | undefined;
    lastAppliedBaseConfigHash?: string | undefined;
    lastAppliedRuntimeConfigHash?: string | undefined;
    lastAppliedStateHash?: string | undefined;
}

export interface ManagerState {
    managedSites: Record<string, ManagedSiteState>;
    metadata: ManagerStateMetadata;
    version: typeof MANAGER_STATE_VERSION;
}

export interface PortableManagerStateSnapshot {
    managedSites: Record<string, ManagedSiteState>;
    version: typeof MANAGER_STATE_VERSION;
}

const emailSchema = z.string().trim().toLowerCase().email();
const scopeSchema = z.string().trim().min(1, 'Scopes must not be empty.');
const siteIdSchema = z.string().trim().min(1, 'Managed site IDs must not be empty.');
const hashSchema = z.string().trim().min(1);
const isoTimestampSchema = z.iso.datetime();

const rawManagerGrantSchema = z
    .object({
        email: z.string(),
        scopes: z.array(z.string()).min(1, 'Grant scopes must not be empty.'),
    })
    .strict();

const rawManagedSiteStateSchema = z
    .object({
        grants: z.array(rawManagerGrantSchema).default([]),
        scopeCatalog: z.array(z.string()).default([]),
    })
    .strict();

const rawManagerStateMetadataSchema = z
    .object({
        lastAppliedAt: isoTimestampSchema.optional(),
        lastAppliedBaseConfigHash: hashSchema.optional(),
        lastAppliedRuntimeConfigHash: hashSchema.optional(),
        lastAppliedStateHash: hashSchema.optional(),
    })
    .strict()
    .default({});

const rawManagerStateSchema = z
    .object({
        managedSites: z.record(siteIdSchema, rawManagedSiteStateSchema).default({}),
        metadata: rawManagerStateMetadataSchema,
        version: z.literal(MANAGER_STATE_VERSION),
    })
    .strict();

const rawPortableManagerStateSnapshotSchema = z
    .object({
        managedSites: z.record(siteIdSchema, rawManagedSiteStateSchema).default({}),
        version: z.literal(MANAGER_STATE_VERSION),
    })
    .strict();

function normaliseScopes(scopes: readonly string[], sourceName: string): string[] {
    const normalizedScopes = scopes.map((scope) => scopeSchema.parse(scope));
    const deduplicatedScopes = [...new Set(normalizedScopes)].sort((left, right) =>
        left.localeCompare(right),
    );

    if (deduplicatedScopes.includes(FULL_ACCESS_SCOPE) && deduplicatedScopes.length > 1) {
        throw new Error(
            `${sourceName} cannot mix ${FULL_ACCESS_SCOPE} with named scopes in the same grant.`,
        );
    }

    return deduplicatedScopes;
}

function normalizeScopeCatalog(scopes: readonly string[], sourceName: string): string[] {
    const normalizedScopes = normaliseScopes(scopes, sourceName);
    if (normalizedScopes.includes(FULL_ACCESS_SCOPE)) {
        throw new Error(`${sourceName} cannot contain ${FULL_ACCESS_SCOPE}.`);
    }

    return [...new Set(normalizedScopes)].sort((left, right) => left.localeCompare(right));
}

function normalizeManagedSiteState(siteId: string, siteState: ManagedSiteState): ManagedSiteState {
    const grantsByEmail = new Map<string, Set<string>>();
    const normalizedScopeCatalog = normalizeScopeCatalog(
        siteState.scopeCatalog,
        `managedSites.${siteId}.scopeCatalog`,
    );

    for (const [grantIndex, grant] of siteState.grants.entries()) {
        const normalizedEmail = emailSchema.parse(grant.email);
        const normalizedScopes = normaliseScopes(
            grant.scopes,
            `managedSites.${siteId}.grants[${grantIndex}].scopes`,
        );
        const existingScopes = grantsByEmail.get(normalizedEmail) ?? new Set<string>();
        for (const scope of normalizedScopes) {
            existingScopes.add(scope);
        }
        if (existingScopes.has(FULL_ACCESS_SCOPE) && existingScopes.size > 1) {
            throw new Error(
                `managedSites.${siteId}.grants for ${normalizedEmail} cannot mix ${FULL_ACCESS_SCOPE} with named scopes.`,
            );
        }
        grantsByEmail.set(normalizedEmail, existingScopes);
    }

    const normalizedGrants = [...grantsByEmail.entries()]
        .map(
            ([email, scopes]): ManagerGrant => ({
                email,
                scopes: normaliseScopes(
                    [...scopes],
                    `managedSites.${siteId}.grants for ${email}.scopes`,
                ),
            }),
        )
        .sort((left, right) => left.email.localeCompare(right.email));

    return {
        grants: normalizedGrants,
        scopeCatalog: normalizedScopeCatalog,
    };
}

function normalizeManagedSites(
    managedSites: Record<string, ManagedSiteState>,
): Record<string, ManagedSiteState> {
    const normalizedEntries = Object.entries(managedSites)
        .map(([siteId, siteState]): [string, ManagedSiteState] => {
            const normalizedSiteId = siteIdSchema.parse(siteId);
            return [normalizedSiteId, normalizeManagedSiteState(normalizedSiteId, siteState)];
        })
        .sort(([leftSiteId], [rightSiteId]) => leftSiteId.localeCompare(rightSiteId));

    const deduplicatedEntries = new Map<string, ManagedSiteState>();
    for (const [siteId, siteState] of normalizedEntries) {
        if (deduplicatedEntries.has(siteId)) {
            throw new Error(`Managed site IDs must be unique: ${siteId}`);
        }

        deduplicatedEntries.set(siteId, siteState);
    }

    return Object.fromEntries(deduplicatedEntries);
}

function normalizeManagerStateMetadata(metadata: ManagerStateMetadata): ManagerStateMetadata {
    return {
        lastAppliedAt: metadata.lastAppliedAt,
        lastAppliedBaseConfigHash: metadata.lastAppliedBaseConfigHash,
        lastAppliedRuntimeConfigHash: metadata.lastAppliedRuntimeConfigHash,
        lastAppliedStateHash: metadata.lastAppliedStateHash,
    };
}

export function normalizeManagerState(state: ManagerState): ManagerState {
    return {
        version: MANAGER_STATE_VERSION,
        managedSites: normalizeManagedSites(state.managedSites),
        metadata: normalizeManagerStateMetadata(state.metadata),
    };
}

export function normalizePortableManagerStateSnapshot(
    snapshot: PortableManagerStateSnapshot,
): PortableManagerStateSnapshot {
    return {
        version: MANAGER_STATE_VERSION,
        managedSites: normalizeManagedSites(snapshot.managedSites),
    };
}

export function resetManagerStateApplyMetadata(state: ManagerState): ManagerState {
    const normalizedState = normalizeManagerState(state);
    return {
        ...normalizedState,
        metadata: {},
    };
}

export function createPortableManagerStateSnapshot(
    state: ManagerState,
): PortableManagerStateSnapshot {
    const normalizedState = normalizeManagerState(state);
    return {
        version: normalizedState.version,
        managedSites: normalizedState.managedSites,
    };
}

export function createManagerStateFromPortableSnapshot(
    snapshot: PortableManagerStateSnapshot,
): ManagerState {
    return resetManagerStateApplyMetadata({
        version: snapshot.version,
        managedSites: snapshot.managedSites,
        metadata: {},
    });
}

export function createEmptyManagerState(siteIds: readonly string[] = []): ManagerState {
    const managedSites = Object.fromEntries(
        [...new Set(siteIds.map((siteId) => siteIdSchema.parse(siteId)))]
            .sort((left, right) => left.localeCompare(right))
            .map((siteId) => [siteId, { grants: [], scopeCatalog: [] }]),
    );

    return {
        version: MANAGER_STATE_VERSION,
        managedSites,
        metadata: {},
    };
}

export function parseManagerStateJson(fileContents: string, filePath: string): ManagerState {
    let parsedJson: unknown;
    try {
        parsedJson = JSON.parse(fileContents);
    } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        throw new Error(`Failed to parse manager state file (${filePath}): ${message}`);
    }

    const parsedState = rawManagerStateSchema.safeParse(parsedJson);
    if (!parsedState.success) {
        const firstIssue = parsedState.error.issues[0];
        const issueMessage =
            typeof firstIssue === 'undefined'
                ? 'Invalid manager state.'
                : firstIssue.path.length > 0
                  ? `${firstIssue.path.map(String).join('.')}: ${firstIssue.message}`
                  : firstIssue.message;
        throw new Error(`Failed to validate manager state file (${filePath}): ${issueMessage}`);
    }

    return normalizeManagerState(parsedState.data);
}

export function parsePortableManagerStateSnapshotJson(
    fileContents: string,
    filePath: string,
): PortableManagerStateSnapshot {
    let parsedJson: unknown;
    try {
        parsedJson = JSON.parse(fileContents);
    } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        throw new Error(
            `Failed to parse portable manager state snapshot (${filePath}): ${message}`,
        );
    }

    const parsedSnapshot = rawPortableManagerStateSnapshotSchema.safeParse(parsedJson);
    if (!parsedSnapshot.success) {
        const firstIssue = parsedSnapshot.error.issues[0];
        const issueMessage =
            typeof firstIssue === 'undefined'
                ? 'Invalid portable manager state snapshot.'
                : firstIssue.path.length > 0
                  ? `${firstIssue.path.map(String).join('.')}: ${firstIssue.message}`
                  : firstIssue.message;
        throw new Error(
            `Failed to validate portable manager state snapshot (${filePath}): ${issueMessage}`,
        );
    }

    return normalizePortableManagerStateSnapshot(parsedSnapshot.data);
}

export function stringifyManagerState(state: ManagerState): string {
    return `${JSON.stringify(normalizeManagerState(state), null, 2)}\n`;
}

export function stringifyPortableManagerStateSnapshot(
    snapshot: PortableManagerStateSnapshot,
): string {
    return `${JSON.stringify(normalizePortableManagerStateSnapshot(snapshot), null, 2)}\n`;
}

export function saveManagerState(filePath: string, state: ManagerState): void {
    writeTextFileAtomically(filePath, stringifyManagerState(state));
}

export function loadManagerState(filePath: string): ManagerState {
    const fileContents = readFileSync(filePath, 'utf8');
    return parseManagerStateJson(fileContents, filePath);
}
