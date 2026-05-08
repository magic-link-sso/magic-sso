// SPDX-License-Identifier: GPL-3.0-or-later

import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { afterEach, describe, expect, it } from 'vitest';
import {
    buildManagerReconcilePreview,
    previewPortableManagerStateImport,
    type ManagerReconcileSource,
} from './service.js';
import { MANAGER_STATE_VERSION, type ManagerState } from './state.js';
import { type ManagerRuntimeSettings } from './settings.js';

const tempDirectories: string[] = [];

function createBaseConfigToml(): string {
    return `
[auth]
jwtSecret = "jwt-secret-0123456789-0123456789"
csrfSecret = "csrf-secret-0123456789-012345678"
emailSecret = "email-secret-0123456789-01234567"
previewSecret = "preview-secret-0123456789-0123456"

[email]
from = "owner@example.com"

[email.smtp]
host = "smtp.example.com"
user = "smtp-user"
pass = "smtp-password"

[[sites]]
id = "docs"
origins = ["http://docs.example.com"]
allowedRedirectUris = ["http://docs.example.com/verify-email"]
allowedEmails = ["docs@example.com"]

[[sites]]
id = "client"
origins = ["http://client.example.com"]
allowedRedirectUris = ["http://client.example.com/verify-email", "http://client.example.com/*"]
allowedEmails = ["base-admin@example.com"]

[[sites.accessRules]]
email = "base-analyst@example.com"
scopes = ["reports", "analytics"]
    `.trimStart();
}

function createRuntimeConfigToml(): string {
    return `
[auth]
jwtSecret = "jwt-secret-0123456789-0123456789"
csrfSecret = "csrf-secret-0123456789-012345678"
emailSecret = "email-secret-0123456789-01234567"
previewSecret = "preview-secret-0123456789-0123456"

[email]
from = "owner@example.com"

[email.smtp]
host = "smtp.example.com"
user = "smtp-user"
pass = "smtp-password"

[[sites]]
id = "docs"
origins = ["http://docs.example.com"]
allowedRedirectUris = ["http://docs.example.com/verify-email"]
allowedEmails = ["docs@example.com"]

[[sites]]
id = "client"
origins = ["http://client.example.com"]
allowedRedirectUris = ["http://client.example.com/verify-email", "http://client.example.com/*"]
allowedEmails = ["runtime-admin@example.com"]

[[sites.accessRules]]
email = "runtime-analyst@example.com"
scopes = ["billing"]
    `.trimStart();
}

function createSettings(tempDirectory: string): ManagerRuntimeSettings {
    return {
        configFilePath: join(tempDirectory, 'manager', 'manager.toml'),
        managedSiteIds: ['client'],
        paths: {
            auditFile: join(tempDirectory, 'manager-audit.ndjson'),
            baseConfigFile: join(tempDirectory, 'magic-sso.base.toml'),
            lastGoodRuntimeConfigFile: join(tempDirectory, 'magic-sso.runtime.last-good.toml'),
            lockFile: join(tempDirectory, 'manager.lock'),
            runtimeConfigFile: join(tempDirectory, 'magic-sso.runtime.toml'),
            stateFile: join(tempDirectory, 'manager-state.json'),
        },
    };
}

function createState(): ManagerState {
    return {
        version: MANAGER_STATE_VERSION,
        managedSites: {
            client: {
                grants: [
                    {
                        email: 'legacy-admin@example.com',
                        scopes: ['*'],
                    },
                    {
                        email: 'reports@example.com',
                        scopes: ['reports'],
                    },
                ],
                scopeCatalog: ['exports', 'reports'],
            },
        },
        metadata: {
            lastAppliedAt: '2026-05-02T09:00:00.000Z',
            lastAppliedBaseConfigHash: 'base-hash',
            lastAppliedRuntimeConfigHash: 'runtime-hash',
            lastAppliedStateHash: 'state-hash',
        },
    };
}

function createTempDirectory(prefix: string): string {
    const tempDirectory = mkdtempSync(join(tmpdir(), prefix));
    tempDirectories.push(tempDirectory);
    return tempDirectory;
}

afterEach((): void => {
    for (const directory of tempDirectories) {
        rmSync(directory, { force: true, recursive: true });
    }
    tempDirectories.length = 0;
});

describe('manager reconciliation previews', () => {
    it.each([
        [
            'base',
            ['client'],
            {
                changedSites: [
                    {
                        addedFullAccessEmails: ['base-admin@example.com'],
                        addedScopedGrants: [
                            {
                                email: 'base-analyst@example.com',
                                scopes: ['analytics', 'reports'],
                            },
                        ],
                        removedFullAccessEmails: ['runtime-admin@example.com'],
                        removedScopedGrants: [
                            {
                                email: 'runtime-analyst@example.com',
                                scopes: ['billing'],
                            },
                        ],
                        siteId: 'client',
                    },
                ],
                hasChanges: true,
            },
            {
                grants: [
                    {
                        email: 'base-admin@example.com',
                        scopes: ['*'],
                    },
                    {
                        email: 'base-analyst@example.com',
                        scopes: ['analytics', 'reports'],
                    },
                ],
                scopeCatalog: ['analytics', 'exports', 'reports'],
            },
        ],
        [
            'runtime',
            [],
            {
                changedSites: [],
                hasChanges: false,
            },
            {
                grants: [
                    {
                        email: 'runtime-admin@example.com',
                        scopes: ['*'],
                    },
                    {
                        email: 'runtime-analyst@example.com',
                        scopes: ['billing'],
                    },
                ],
                scopeCatalog: ['billing', 'exports', 'reports'],
            },
        ],
    ] satisfies Array<
        [
            ManagerReconcileSource,
            string[],
            {
                changedSites: Array<{
                    addedFullAccessEmails: string[];
                    addedScopedGrants: Array<{ email: string; scopes: string[] }>;
                    removedFullAccessEmails: string[];
                    removedScopedGrants: Array<{ email: string; scopes: string[] }>;
                    siteId: string;
                }>;
                hasChanges: boolean;
            },
            {
                grants: Array<{ email: string; scopes: string[] }>;
                scopeCatalog: string[];
            },
        ]
    >)(
        'reconciles managed grants from %s while preserving existing scope catalog entries',
        (source, expectedChangedSiteIds, expectedDiff, expectedSiteState): void => {
            const tempDirectory = createTempDirectory(`magic-sso-manager-reconcile-${source}-`);
            const settings = createSettings(tempDirectory);
            writeFileSync(settings.paths.baseConfigFile, createBaseConfigToml(), 'utf8');
            writeFileSync(settings.paths.runtimeConfigFile, createRuntimeConfigToml(), 'utf8');

            const preview = buildManagerReconcilePreview(createState(), settings, source);

            expect(preview.source).toBe(source);
            expect(preview.changedSiteIds).toEqual(expectedChangedSiteIds);
            expect(preview.diff).toEqual(expectedDiff);
            expect(preview.state.managedSites.client).toEqual(expectedSiteState);
            expect(preview.state.metadata).toEqual({});
        },
    );

    it('resets metadata and previews portable state replacement against the current runtime plan', () => {
        const tempDirectory = createTempDirectory('magic-sso-manager-import-preview-');
        const settings = createSettings(tempDirectory);
        writeFileSync(settings.paths.baseConfigFile, createBaseConfigToml(), 'utf8');

        const preview = previewPortableManagerStateImport(createState(), settings, {
            version: MANAGER_STATE_VERSION,
            managedSites: {
                client: {
                    grants: [
                        {
                            email: 'Viewer@Example.com',
                            scopes: ['analytics', 'reports'],
                        },
                    ],
                    scopeCatalog: ['analytics', 'reports'],
                },
            },
        });

        expect(preview.changedSiteIds).toEqual(['client']);
        expect(preview.state).toEqual({
            version: MANAGER_STATE_VERSION,
            managedSites: {
                client: {
                    grants: [
                        {
                            email: 'viewer@example.com',
                            scopes: ['analytics', 'reports'],
                        },
                    ],
                    scopeCatalog: ['analytics', 'reports'],
                },
            },
            metadata: {},
        });
        expect(preview.diff.hasChanges).toBe(true);
    });
});
