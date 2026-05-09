// SPDX-License-Identifier: GPL-3.0-or-later

import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { FULL_ACCESS_SCOPE } from '@magic-link-sso/config-core';
import { afterEach, describe, expect, it } from 'vitest';
import {
    MANAGER_STATE_VERSION,
    createManagerStateFromPortableSnapshot,
    createEmptyManagerState,
    createPortableManagerStateSnapshot,
    loadManagerState,
    normalizeManagerState,
    parsePortableManagerStateSnapshotJson,
    resetManagerStateApplyMetadata,
    parseManagerStateJson,
    stringifyPortableManagerStateSnapshot,
    stringifyManagerState,
    type ManagerState,
} from './state.js';

const tempDirectories: string[] = [];

afterEach(() => {
    for (const directory of tempDirectories) {
        rmSync(directory, { force: true, recursive: true });
    }
    tempDirectories.length = 0;
});

describe('manager state', () => {
    it('normalizes managed site grants, scopes, and ordering', () => {
        const normalizedState = normalizeManagerState({
            version: MANAGER_STATE_VERSION,
            managedSites: {
                zebra: {
                    grants: [
                        {
                            email: ' Viewer@Example.com ',
                            scopes: [' reports ', 'analytics', 'reports'],
                        },
                    ],
                    scopeCatalog: ['reports', ' analytics ', 'reports'],
                },
                alpha: {
                    grants: [
                        {
                            email: ' Admin@Example.com ',
                            scopes: [FULL_ACCESS_SCOPE],
                        },
                        {
                            email: 'viewer@example.com',
                            scopes: ['billing'],
                        },
                        {
                            email: ' VIEWER@example.com ',
                            scopes: ['analytics'],
                        },
                    ],
                    scopeCatalog: ['analytics', 'billing'],
                },
            },
            metadata: {
                lastAppliedStateHash: 'state-hash',
            },
        });

        expect(normalizedState).toEqual({
            version: MANAGER_STATE_VERSION,
            managedSites: {
                alpha: {
                    grants: [
                        {
                            email: 'admin@example.com',
                            scopes: [FULL_ACCESS_SCOPE],
                        },
                        {
                            email: 'viewer@example.com',
                            scopes: ['analytics', 'billing'],
                        },
                    ],
                    scopeCatalog: ['analytics', 'billing'],
                },
                zebra: {
                    grants: [
                        {
                            email: 'viewer@example.com',
                            scopes: ['analytics', 'reports'],
                        },
                    ],
                    scopeCatalog: ['analytics', 'reports'],
                },
            },
            metadata: {
                lastAppliedAt: undefined,
                lastAppliedBaseConfigHash: undefined,
                lastAppliedRuntimeConfigHash: undefined,
                lastAppliedStateHash: 'state-hash',
            },
        });
    });

    it('rejects empty scopes after trimming', () => {
        expect(() =>
            normalizeManagerState({
                version: MANAGER_STATE_VERSION,
                managedSites: {
                    client: {
                        grants: [
                            {
                                email: 'viewer@example.com',
                                scopes: ['   '],
                            },
                        ],
                        scopeCatalog: [],
                    },
                },
                metadata: {},
            }),
        ).toThrowError('Scopes must not be empty.');
    });

    it('rejects wildcard grants mixed with named scopes across duplicates', () => {
        expect(() =>
            normalizeManagerState({
                version: MANAGER_STATE_VERSION,
                managedSites: {
                    client: {
                        grants: [
                            {
                                email: 'viewer@example.com',
                                scopes: [FULL_ACCESS_SCOPE],
                            },
                            {
                                email: ' VIEWER@example.com ',
                                scopes: ['reports'],
                            },
                        ],
                        scopeCatalog: ['reports'],
                    },
                },
                metadata: {},
            }),
        ).toThrowError(
            'managedSites.client.grants for viewer@example.com cannot mix * with named scopes.',
        );
    });

    it('parses, loads, and stringifies normalized manager state', () => {
        const stateFilePath = '/tmp/manager-state.json';
        const parsedState = parseManagerStateJson(
            JSON.stringify({
                version: MANAGER_STATE_VERSION,
                managedSites: {
                    client: {
                        grants: [
                            {
                                email: 'User@Example.com',
                                scopes: ['reports'],
                            },
                        ],
                        scopeCatalog: ['reports'],
                    },
                },
                metadata: {
                    lastAppliedAt: '2026-05-02T09:00:00.000Z',
                    lastAppliedBaseConfigHash: 'base-hash',
                    lastAppliedRuntimeConfigHash: 'runtime-hash',
                    lastAppliedStateHash: 'state-hash',
                },
            }),
            stateFilePath,
        );

        const tempDirectory = mkdtempSync(join(tmpdir(), 'magic-sso-manager-state-'));
        tempDirectories.push(tempDirectory);
        const filePath = join(tempDirectory, 'manager-state.json');
        writeFileSync(filePath, stringifyManagerState(parsedState), 'utf8');

        expect(loadManagerState(filePath)).toEqual(parsedState);
        expect(stringifyManagerState(parsedState)).toContain('"user@example.com"');
    });

    it('creates an empty manager state for the requested site ids', () => {
        const emptyState = createEmptyManagerState(['beta', 'alpha', 'alpha']);

        expect(emptyState).toEqual({
            version: MANAGER_STATE_VERSION,
            managedSites: {
                alpha: {
                    grants: [],
                    scopeCatalog: [],
                },
                beta: {
                    grants: [],
                    scopeCatalog: [],
                },
            },
            metadata: {},
        });
    });

    it('creates portable snapshots without apply metadata', () => {
        const snapshot = createPortableManagerStateSnapshot({
            version: MANAGER_STATE_VERSION,
            managedSites: {
                client: {
                    grants: [
                        {
                            email: 'Admin@Example.com',
                            scopes: ['reports', 'analytics'],
                        },
                    ],
                    scopeCatalog: ['reports', 'analytics'],
                },
            },
            metadata: {
                lastAppliedAt: '2026-05-02T09:00:00.000Z',
                lastAppliedBaseConfigHash: 'base-hash',
                lastAppliedRuntimeConfigHash: 'runtime-hash',
                lastAppliedStateHash: 'state-hash',
            },
        });

        expect(snapshot).toEqual({
            version: MANAGER_STATE_VERSION,
            managedSites: {
                client: {
                    grants: [
                        {
                            email: 'admin@example.com',
                            scopes: ['analytics', 'reports'],
                        },
                    ],
                    scopeCatalog: ['analytics', 'reports'],
                },
            },
        });
        expect(stringifyPortableManagerStateSnapshot(snapshot)).not.toContain('lastAppliedAt');
    });

    it('restores manager state from portable snapshots with cleared apply metadata', () => {
        const restoredState = createManagerStateFromPortableSnapshot({
            version: MANAGER_STATE_VERSION,
            managedSites: {
                client: {
                    grants: [
                        {
                            email: 'Viewer@Example.com',
                            scopes: ['reports'],
                        },
                    ],
                    scopeCatalog: ['reports'],
                },
            },
        });

        expect(restoredState).toEqual({
            version: MANAGER_STATE_VERSION,
            managedSites: {
                client: {
                    grants: [
                        {
                            email: 'viewer@example.com',
                            scopes: ['reports'],
                        },
                    ],
                    scopeCatalog: ['reports'],
                },
            },
            metadata: {},
        });
    });

    it('resets apply metadata without touching normalized grants', () => {
        const resetState = resetManagerStateApplyMetadata({
            version: MANAGER_STATE_VERSION,
            managedSites: {
                client: {
                    grants: [
                        {
                            email: 'Viewer@Example.com',
                            scopes: ['reports'],
                        },
                    ],
                    scopeCatalog: ['reports'],
                },
            },
            metadata: {
                lastAppliedAt: '2026-05-02T09:00:00.000Z',
                lastAppliedBaseConfigHash: 'base-hash',
                lastAppliedRuntimeConfigHash: 'runtime-hash',
                lastAppliedStateHash: 'state-hash',
            },
        });

        expect(resetState).toEqual({
            version: MANAGER_STATE_VERSION,
            managedSites: {
                client: {
                    grants: [
                        {
                            email: 'viewer@example.com',
                            scopes: ['reports'],
                        },
                    ],
                    scopeCatalog: ['reports'],
                },
            },
            metadata: {},
        });
    });

    it('parses portable snapshots and rejects unexpected metadata payloads', () => {
        const parsedSnapshot = parsePortableManagerStateSnapshotJson(
            JSON.stringify({
                version: MANAGER_STATE_VERSION,
                managedSites: {
                    client: {
                        grants: [
                            {
                                email: 'User@Example.com',
                                scopes: ['reports'],
                            },
                        ],
                        scopeCatalog: ['reports'],
                    },
                },
            }),
            '/tmp/portable-manager-state.json',
        );

        expect(parsedSnapshot).toEqual({
            version: MANAGER_STATE_VERSION,
            managedSites: {
                client: {
                    grants: [
                        {
                            email: 'user@example.com',
                            scopes: ['reports'],
                        },
                    ],
                    scopeCatalog: ['reports'],
                },
            },
        });

        expect(() =>
            parsePortableManagerStateSnapshotJson(
                JSON.stringify({
                    version: MANAGER_STATE_VERSION,
                    managedSites: {},
                    metadata: {},
                }),
                '/tmp/portable-manager-state.json',
            ),
        ).toThrowError(
            'Failed to validate portable manager state snapshot (/tmp/portable-manager-state.json): Unrecognized key: "metadata"',
        );
    });

    it('rejects invalid persisted versions', () => {
        const invalidState = {
            version: 2,
            managedSites: {},
            metadata: {},
        } satisfies Omit<ManagerState, 'version'> & { version: number };

        expect(() =>
            parseManagerStateJson(JSON.stringify(invalidState), '/tmp/manager-state.json'),
        ).toThrowError(
            'Failed to validate manager state file (/tmp/manager-state.json): version: Invalid input: expected 1',
        );
    });
});
