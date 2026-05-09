// SPDX-License-Identifier: GPL-3.0-or-later

import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { afterEach, describe, expect, it } from 'vitest';
import { buildApp } from './app.js';
import { type ManagerRuntimeSettings } from './settings.js';

const tempDirectories: string[] = [];
const authHeader = {
    authorization: 'Bearer replace-me-with-a-dedicated-long-random-manager-api-token',
};

function createSettings(overrides: Partial<ManagerRuntimeSettings> = {}): ManagerRuntimeSettings {
    return {
        audit: {
            integrityKey: 'manager-audit-integrity-key-0123456789abcdefghij',
            maxArchivedFiles: 4,
            maxFileBytes: 1024 * 1024,
        },
        configFilePath: '/tmp/manager.toml',
        managedSiteIds: ['client'],
        paths: {
            auditFile: '/tmp/manager-audit.ndjson',
            baseConfigFile: '/tmp/magic-sso.base.toml',
            lastGoodRuntimeConfigFile: '/tmp/magic-sso.runtime.last-good.toml',
            lockFile: '/tmp/manager.lock',
            runtimeConfigFile: '/tmp/magic-sso.runtime.toml',
            stateFile: '/tmp/manager-state.json',
        },
        service: {
            auth: {
                bearerToken: 'replace-me-with-a-dedicated-long-random-manager-api-token',
            },
            host: '127.0.0.1',
            port: 4311,
        },
        ...overrides,
    };
}

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
allowedEmails = ["legacy-admin@example.com"]
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
email = "runtime-viewer@example.com"
scopes = ["reports"]
    `.trimStart();
}

function createTempDirectory(prefix: string): string {
    const tempDirectory = mkdtempSync(join(tmpdir(), prefix));
    tempDirectories.push(tempDirectory);
    return tempDirectory;
}

function createFileBackedSettings(tempDirectory: string): ManagerRuntimeSettings {
    return createSettings({
        configFilePath: join(tempDirectory, 'manager', 'manager.toml'),
        paths: {
            auditFile: join(tempDirectory, 'manager-audit.ndjson'),
            baseConfigFile: join(tempDirectory, 'magic-sso.base.toml'),
            lastGoodRuntimeConfigFile: join(tempDirectory, 'magic-sso.runtime.last-good.toml'),
            lockFile: join(tempDirectory, 'manager.lock'),
            runtimeConfigFile: join(tempDirectory, 'magic-sso.runtime.toml'),
            stateFile: join(tempDirectory, 'manager-state.json'),
        },
    });
}

afterEach(() => {
    for (const directory of tempDirectories) {
        rmSync(directory, { force: true, recursive: true });
    }
    tempDirectories.length = 0;
});

describe('manager service write endpoints', () => {
    it('keeps site provisioning and global config edits outside the api surface', async () => {
        const tempDirectory = createTempDirectory('magic-sso-manager-api-scope-');
        const settings = createFileBackedSettings(tempDirectory);
        writeFileSync(settings.paths.baseConfigFile, createBaseConfigToml(), 'utf8');

        const app = await buildApp({
            logger: false,
            settings,
        });

        try {
            const provisioningResponse = await app.inject({
                headers: authHeader,
                method: 'POST',
                payload: {
                    id: 'new-site',
                },
                url: '/api/sites',
            });
            expect(provisioningResponse.statusCode).toBe(404);

            const deleteSiteResponse = await app.inject({
                headers: authHeader,
                method: 'DELETE',
                url: '/api/sites/client',
            });
            expect(deleteSiteResponse.statusCode).toBe(404);

            const globalConfigResponse = await app.inject({
                headers: authHeader,
                method: 'PATCH',
                payload: {
                    appUrl: 'http://manager.example.com',
                },
                url: '/api/server',
            });
            expect(globalConfigResponse.statusCode).toBe(404);
        } finally {
            await app.close();
        }
    });

    it('creates, replaces, updates, and deletes grants', async () => {
        const tempDirectory = createTempDirectory('magic-sso-manager-api-write-access-');
        const settings = createFileBackedSettings(tempDirectory);
        writeFileSync(settings.paths.baseConfigFile, createBaseConfigToml(), 'utf8');

        const app = await buildApp({
            logger: false,
            settings,
        });

        try {
            let response = await app.inject({
                headers: authHeader,
                method: 'POST',
                payload: {
                    scope: 'reports',
                },
                url: '/api/sites/client/scopes',
            });
            expect(response.statusCode).toBe(200);

            response = await app.inject({
                headers: authHeader,
                method: 'POST',
                payload: {
                    email: 'reports@example.com',
                    scopes: ['reports'],
                },
                url: '/api/sites/client/access/grants',
            });
            expect(response.statusCode).toBe(200);
            expect(response.json()).toMatchObject({
                site: {
                    grants: [
                        {
                            email: 'reports@example.com',
                            scopes: ['reports'],
                        },
                    ],
                },
            });

            response = await app.inject({
                headers: authHeader,
                method: 'PATCH',
                payload: {
                    fullAccess: true,
                },
                url: '/api/sites/client/access/grants/reports@example.com',
            });
            expect(response.statusCode).toBe(200);
            expect(response.json()).toMatchObject({
                site: {
                    grants: [
                        {
                            email: 'reports@example.com',
                            scopes: ['*'],
                        },
                    ],
                },
            });

            response = await app.inject({
                headers: authHeader,
                method: 'PUT',
                payload: {
                    grants: [
                        {
                            email: 'alpha@example.com',
                            scopes: ['reports'],
                        },
                        {
                            email: 'beta@example.com',
                            fullAccess: true,
                        },
                    ],
                },
                url: '/api/sites/client/access',
            });
            expect(response.statusCode).toBe(200);
            expect(response.json()).toMatchObject({
                site: {
                    grants: [
                        {
                            email: 'alpha@example.com',
                            scopes: ['reports'],
                        },
                        {
                            email: 'beta@example.com',
                            scopes: ['*'],
                        },
                    ],
                },
            });

            response = await app.inject({
                headers: authHeader,
                method: 'DELETE',
                url: '/api/sites/client/access/grants/alpha@example.com',
            });
            expect(response.statusCode).toBe(200);
            expect(response.json()).toMatchObject({
                site: {
                    grants: [
                        {
                            email: 'beta@example.com',
                            scopes: ['*'],
                        },
                    ],
                },
            });

            const savedState = JSON.parse(readFileSync(settings.paths.stateFile, 'utf8')) as {
                managedSites: {
                    client: {
                        grants: Array<{ email: string; scopes: string[] }>;
                    };
                };
            };
            expect(savedState.managedSites.client.grants).toEqual([
                {
                    email: 'beta@example.com',
                    scopes: ['*'],
                },
            ]);

            const auditEvents = readFileSync(settings.paths.auditFile, 'utf8')
                .trim()
                .split('\n')
                .map((line) => JSON.parse(line) as { actor: { user: string }; kind: string });
            expect(auditEvents.map((event) => event.kind)).toEqual([
                'scope-added',
                'grant-saved',
                'grant-saved',
                'access-replaced',
                'grant-revoked',
            ]);
            expect(auditEvents.every((event) => event.actor.user === 'internal-bearer-token')).toBe(
                true,
            );
        } finally {
            await app.close();
        }
    });

    it('creates, replaces, and deletes scopes with guardrails', async () => {
        const tempDirectory = createTempDirectory('magic-sso-manager-api-write-scopes-');
        const settings = createFileBackedSettings(tempDirectory);
        writeFileSync(settings.paths.baseConfigFile, createBaseConfigToml(), 'utf8');

        const app = await buildApp({
            logger: false,
            settings,
        });

        try {
            let response = await app.inject({
                headers: authHeader,
                method: 'POST',
                payload: {
                    scope: 'reports',
                },
                url: '/api/sites/client/scopes',
            });
            expect(response.statusCode).toBe(200);

            response = await app.inject({
                headers: authHeader,
                method: 'POST',
                payload: {
                    email: 'reports@example.com',
                    scopes: ['reports'],
                },
                url: '/api/sites/client/access/grants',
            });
            expect(response.statusCode).toBe(200);

            response = await app.inject({
                headers: authHeader,
                method: 'PUT',
                payload: {
                    scopes: ['analytics', 'reports'],
                },
                url: '/api/sites/client/scopes',
            });
            expect(response.statusCode).toBe(200);
            expect(response.json()).toMatchObject({
                site: {
                    scopeCatalog: ['analytics', 'reports'],
                },
            });

            const conflictResponse = await app.inject({
                headers: authHeader,
                method: 'DELETE',
                url: '/api/sites/client/scopes/reports',
            });
            expect(conflictResponse.statusCode).toBe(409);
            expect(conflictResponse.json()).toEqual({
                code: 'scope_in_use',
                message: 'Scope reports is still assigned on client.',
            });

            response = await app.inject({
                headers: authHeader,
                method: 'DELETE',
                url: '/api/sites/client/access/grants/reports@example.com',
            });
            expect(response.statusCode).toBe(200);

            response = await app.inject({
                headers: authHeader,
                method: 'DELETE',
                url: '/api/sites/client/scopes/reports',
            });
            expect(response.statusCode).toBe(200);
            expect(response.json()).toMatchObject({
                site: {
                    scopeCatalog: ['analytics'],
                },
            });

            const auditEvents = readFileSync(settings.paths.auditFile, 'utf8')
                .trim()
                .split('\n')
                .map((line) => JSON.parse(line) as { kind: string });
            expect(auditEvents.map((event) => event.kind)).toEqual([
                'scope-added',
                'grant-saved',
                'scope-catalog-replaced',
                'grant-revoked',
                'scope-removed',
            ]);
        } finally {
            await app.close();
        }
    });

    it('imports portable snapshots and reconciles from runtime config with audit events', async () => {
        const tempDirectory = createTempDirectory('magic-sso-manager-api-write-reconcile-');
        const settings = createFileBackedSettings(tempDirectory);
        writeFileSync(settings.paths.baseConfigFile, createBaseConfigToml(), 'utf8');
        writeFileSync(
            settings.paths.stateFile,
            JSON.stringify(
                {
                    version: 1,
                    managedSites: {
                        client: {
                            grants: [
                                {
                                    email: 'legacy@example.com',
                                    scopes: ['reports'],
                                },
                            ],
                            scopeCatalog: ['reports'],
                        },
                    },
                    metadata: {
                        lastAppliedAt: '2026-05-02T10:00:00.000Z',
                        lastAppliedBaseConfigHash: 'base-hash',
                        lastAppliedRuntimeConfigHash: 'runtime-hash',
                        lastAppliedStateHash: 'state-hash',
                    },
                },
                null,
                2,
            ),
            'utf8',
        );

        const app = await buildApp({
            logger: false,
            settings,
        });

        try {
            let response = await app.inject({
                headers: authHeader,
                method: 'POST',
                payload: {
                    state: {
                        version: 1,
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
                    },
                },
                url: '/api/state/import',
            });
            expect(response.statusCode).toBe(200);
            expect(response.json()).toEqual({
                changedSiteIds: ['client'],
                diff: {
                    changedSites: [
                        {
                            addedFullAccessEmails: [],
                            addedScopedGrants: [
                                {
                                    email: 'viewer@example.com',
                                    scopes: ['reports'],
                                },
                            ],
                            removedFullAccessEmails: ['legacy-admin@example.com'],
                            removedScopedGrants: [],
                            siteId: 'client',
                        },
                    ],
                    hasChanges: true,
                },
                state: {
                    version: 1,
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
                },
            });

            writeFileSync(settings.paths.runtimeConfigFile, createRuntimeConfigToml(), 'utf8');

            response = await app.inject({
                headers: authHeader,
                method: 'POST',
                url: '/api/reconcile/runtime',
            });
            expect(response.statusCode).toBe(200);
            expect(response.json()).toMatchObject({
                changedSiteIds: [],
                source: 'runtime',
                state: {
                    version: 1,
                    managedSites: {
                        client: {
                            grants: [
                                {
                                    email: 'runtime-admin@example.com',
                                    scopes: ['*'],
                                },
                                {
                                    email: 'runtime-viewer@example.com',
                                    scopes: ['reports'],
                                },
                            ],
                            scopeCatalog: ['reports'],
                        },
                    },
                },
            });

            expect(JSON.parse(readFileSync(settings.paths.stateFile, 'utf8'))).toEqual({
                version: 1,
                managedSites: {
                    client: {
                        grants: [
                            {
                                email: 'runtime-admin@example.com',
                                scopes: ['*'],
                            },
                            {
                                email: 'runtime-viewer@example.com',
                                scopes: ['reports'],
                            },
                        ],
                        scopeCatalog: ['reports'],
                    },
                },
                metadata: {},
            });

            const auditEvents = readFileSync(settings.paths.auditFile, 'utf8')
                .trim()
                .split('\n')
                .map((line) => JSON.parse(line) as { kind: string; message: string });
            expect(auditEvents.map((event) => event.kind)).toEqual([
                'state-imported',
                'state-reconciled',
            ]);
            expect(auditEvents[0]?.message).toContain('reset apply metadata');
            expect(auditEvents[1]?.message).toContain('runtime config');
        } finally {
            await app.close();
        }
    });

    it('returns actionable errors for invalid imports and unavailable reconcile sources', async () => {
        const tempDirectory = createTempDirectory('magic-sso-manager-api-write-import-errors-');
        const settings = createFileBackedSettings(tempDirectory);
        writeFileSync(settings.paths.baseConfigFile, createBaseConfigToml(), 'utf8');

        const app = await buildApp({
            logger: false,
            settings,
        });

        try {
            let response = await app.inject({
                headers: authHeader,
                method: 'POST',
                payload: {
                    state: {
                        version: 1,
                        managedSites: {
                            docs: {
                                grants: [],
                                scopeCatalog: [],
                            },
                        },
                    },
                },
                url: '/api/state/import',
            });
            expect(response.statusCode).toBe(400);
            expect(response.json()).toEqual({
                code: 'invalid_state_import',
                message: 'Portable manager state contains an unmanaged site: docs',
            });

            response = await app.inject({
                headers: authHeader,
                method: 'POST',
                url: '/api/reconcile/runtime',
            });
            expect(response.statusCode).toBe(400);
            expect(response.json()).toEqual({
                code: 'reconcile_failed',
                message: `Managed runtime config file is missing: ${settings.paths.runtimeConfigFile}`,
            });
        } finally {
            await app.close();
        }
    });

    it('returns actionable 400 and 404 errors for invalid write requests', async () => {
        const tempDirectory = createTempDirectory('magic-sso-manager-api-write-errors-');
        const settings = createFileBackedSettings(tempDirectory);
        writeFileSync(settings.paths.baseConfigFile, createBaseConfigToml(), 'utf8');

        const app = await buildApp({
            logger: false,
            settings,
        });

        try {
            let response = await app.inject({
                headers: authHeader,
                method: 'POST',
                payload: {
                    email: 'broken@example.com',
                    fullAccess: true,
                    scopes: ['reports'],
                },
                url: '/api/sites/client/access/grants',
            });
            expect(response.statusCode).toBe(400);
            expect(response.json()).toEqual({
                code: 'invalid_grant_payload',
                message: 'Use either "fullAccess": true or a non-empty "scopes" array, not both.',
            });

            response = await app.inject({
                headers: authHeader,
                method: 'POST',
                payload: {
                    email: ' not-an-email ',
                    scopes: ['reports'],
                },
                url: '/api/sites/client/access/grants',
            });
            expect(response.statusCode).toBe(400);
            expect(response.json()).toEqual({
                code: 'invalid_request_body',
                message: 'Invalid request body: Invalid email address',
            });

            response = await app.inject({
                headers: authHeader,
                method: 'POST',
                payload: {
                    email: 'missing@example.com',
                    scopes: ['reports'],
                },
                url: '/api/sites/client/access/grants',
            });
            expect(response.statusCode).toBe(400);
            expect(response.json()).toEqual({
                code: 'scope_not_in_catalog',
                message:
                    'Scope reports is not in the catalog for client. Add it first with scopes add.',
            });

            response = await app.inject({
                headers: authHeader,
                method: 'DELETE',
                url: '/api/sites/client/access/grants/missing@example.com',
            });
            expect(response.statusCode).toBe(404);
            expect(response.json()).toEqual({
                code: 'grant_not_found',
                message: 'Grant for missing@example.com does not exist on client.',
            });

            response = await app.inject({
                headers: authHeader,
                method: 'POST',
                payload: {},
                url: '/api/sites/client/scopes',
            });
            expect(response.statusCode).toBe(400);
            expect(response.json()).toEqual({
                code: 'invalid_request_body',
                message: 'Invalid request body: Invalid input: expected string, received undefined',
            });

            response = await app.inject({
                headers: authHeader,
                method: 'POST',
                payload: {
                    scope: '   ',
                },
                url: '/api/sites/client/scopes',
            });
            expect(response.statusCode).toBe(400);
            expect(response.json()).toEqual({
                code: 'invalid_request_body',
                message: 'Invalid request body: Too small: expected string to have >=1 characters',
            });
        } finally {
            await app.close();
        }
    });
});
