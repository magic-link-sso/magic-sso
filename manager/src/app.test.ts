// SPDX-License-Identifier: GPL-3.0-or-later

import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { afterEach, describe, expect, it } from 'vitest';
import { buildApp } from './app.js';
import { MANAGER_STATE_VERSION } from './state.js';
import { type ManagerRuntimeSettings } from './settings.js';

const tempDirectories: string[] = [];

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

describe('manager service app', () => {
    it('rejects boot when service settings are missing', async () => {
        await expect(
            buildApp({
                logger: false,
                settings: {
                    ...createSettings(),
                    service: undefined,
                },
            }),
        ).rejects.toThrowError(
            'Manager service settings are not configured. Add [service] to MAGICSSO_MANAGER_CONFIG_FILE.',
        );
    });

    it('exposes an unprotected health endpoint', async () => {
        const app = await buildApp({
            logger: false,
            settings: createSettings(),
        });

        try {
            const response = await app.inject({
                method: 'GET',
                url: '/healthz',
            });

            expect(response.statusCode).toBe(200);
            expect(response.json()).toEqual({
                managedSiteCount: 1,
                status: 'ok',
            });
        } finally {
            await app.close();
        }
    });

    it('protects api routes with the configured bearer token', async () => {
        const tempDirectory = createTempDirectory('magic-sso-manager-auth-');
        const settings = createFileBackedSettings(tempDirectory);
        writeFileSync(settings.paths.baseConfigFile, createBaseConfigToml(), 'utf8');
        const app = await buildApp({
            logger: false,
            settings,
        });

        try {
            const unauthorizedResponse = await app.inject({
                method: 'GET',
                url: '/api/sites',
            });
            expect(unauthorizedResponse.statusCode).toBe(401);
            expect(unauthorizedResponse.json()).toEqual({
                message: 'Missing or invalid Authorization header.',
            });

            const forbiddenResponse = await app.inject({
                method: 'GET',
                url: '/api/sites',
                headers: {
                    authorization: 'Bearer wrong-token',
                },
            });
            expect(forbiddenResponse.statusCode).toBe(403);
            expect(forbiddenResponse.json()).toEqual({
                message: 'Forbidden',
            });

            const authorizedResponse = await app.inject({
                method: 'GET',
                url: '/api/sites',
                headers: {
                    authorization:
                        'Bearer replace-me-with-a-dedicated-long-random-manager-api-token',
                },
            });
            expect(authorizedResponse.statusCode).toBe(200);
            expect(authorizedResponse.json()).toEqual({
                sites: [
                    {
                        allowedRedirectUris: [
                            'http://client.example.com/verify-email',
                            'http://client.example.com/*',
                        ],
                        grantCount: 0,
                        id: 'client',
                        origins: ['http://client.example.com'],
                        scopeCount: 0,
                    },
                ],
            });
        } finally {
            await app.close();
        }
    });

    it('rate limits repeated authenticated mutation requests from the same client IP', async () => {
        const app = await buildApp({
            logger: false,
            settings: createSettings(),
        });

        try {
            for (let attempt = 0; attempt < 30; attempt += 1) {
                const response = await app.inject({
                    headers: {
                        authorization:
                            'Bearer replace-me-with-a-dedicated-long-random-manager-api-token',
                        'x-forwarded-for': `203.0.113.${attempt + 1}`,
                    },
                    method: 'POST',
                    remoteAddress: '198.51.100.10',
                    url: '/api/reload',
                });

                expect(response.statusCode).toBe(400);
                expect(response.json()).toEqual({
                    code: 'reload_not_configured',
                    message:
                        'Manager reload target is not configured. Add [reload] to MAGICSSO_MANAGER_CONFIG_FILE.',
                });
            }

            const limitedResponse = await app.inject({
                headers: {
                    authorization:
                        'Bearer replace-me-with-a-dedicated-long-random-manager-api-token',
                    'x-forwarded-for': '203.0.113.250',
                },
                method: 'POST',
                remoteAddress: '198.51.100.10',
                url: '/api/reload',
            });

            expect(limitedResponse.statusCode).toBe(429);
            expect(limitedResponse.json()).toEqual({
                message: 'Too many requests.',
            });
            expect(
                Number.parseInt(limitedResponse.headers['retry-after'] ?? '0', 10),
            ).toBeGreaterThan(0);
        } finally {
            await app.close();
        }
    });

    it('exposes managed-state read endpoints behind auth', async () => {
        const tempDirectory = createTempDirectory('magic-sso-manager-api-');
        const settings = createFileBackedSettings(tempDirectory);
        writeFileSync(settings.paths.baseConfigFile, createBaseConfigToml(), 'utf8');
        writeFileSync(
            settings.paths.stateFile,
            JSON.stringify(
                {
                    version: MANAGER_STATE_VERSION,
                    managedSites: {
                        client: {
                            grants: [
                                {
                                    email: 'reports@example.com',
                                    scopes: ['analytics', 'reports'],
                                },
                            ],
                            scopeCatalog: ['reports', 'analytics'],
                        },
                    },
                    metadata: {},
                },
                null,
                2,
            ),
            'utf8',
        );
        writeFileSync(
            settings.paths.auditFile,
            [
                JSON.stringify({
                    actor: {
                        host: 'manager-host',
                        user: 'operator',
                    },
                    baseConfigHash: 'base-1',
                    changedSiteIds: ['client'],
                    id: 'evt-1',
                    kind: 'apply-succeeded',
                    message: 'Applied runtime config.',
                    reloaded: false,
                    rolledBack: false,
                    runtimeConfigHash: 'runtime-1',
                    stateHash: 'state-1',
                    timestamp: '2026-05-02T10:00:00.000Z',
                }),
                JSON.stringify({
                    actor: {
                        host: 'manager-host',
                        user: 'operator',
                    },
                    baseConfigHash: 'base-2',
                    changedSiteIds: ['client'],
                    id: 'evt-2',
                    kind: 'apply-failed',
                    message: 'Server reload failed.',
                    reloaded: false,
                    rolledBack: true,
                    runtimeConfigHash: 'runtime-2',
                    stateHash: 'state-2',
                    timestamp: '2026-05-02T10:05:00.000Z',
                }),
            ].join('\n'),
            'utf8',
        );

        const app = await buildApp({
            logger: false,
            settings,
        });

        try {
            const headers = {
                authorization: 'Bearer replace-me-with-a-dedicated-long-random-manager-api-token',
            };

            const listResponse = await app.inject({
                headers,
                method: 'GET',
                url: '/api/sites',
            });
            expect(listResponse.statusCode).toBe(200);
            expect(listResponse.json()).toEqual({
                sites: [
                    {
                        allowedRedirectUris: [
                            'http://client.example.com/verify-email',
                            'http://client.example.com/*',
                        ],
                        grantCount: 1,
                        id: 'client',
                        origins: ['http://client.example.com'],
                        scopeCount: 2,
                    },
                ],
            });

            const siteResponse = await app.inject({
                headers,
                method: 'GET',
                url: '/api/sites/client',
            });
            expect(siteResponse.statusCode).toBe(200);
            expect(siteResponse.json()).toEqual({
                site: {
                    allowedRedirectUris: [
                        'http://client.example.com/verify-email',
                        'http://client.example.com/*',
                    ],
                    grantCount: 1,
                    grants: [
                        {
                            email: 'reports@example.com',
                            scopes: ['analytics', 'reports'],
                        },
                    ],
                    id: 'client',
                    origins: ['http://client.example.com'],
                    scopeCatalog: ['analytics', 'reports'],
                    scopeCount: 2,
                },
            });

            const accessResponse = await app.inject({
                headers,
                method: 'GET',
                url: '/api/sites/client/access',
            });
            expect(accessResponse.statusCode).toBe(200);
            expect(accessResponse.json()).toEqual({
                grants: [
                    {
                        email: 'reports@example.com',
                        scopes: ['analytics', 'reports'],
                    },
                ],
                siteId: 'client',
            });

            const scopesResponse = await app.inject({
                headers,
                method: 'GET',
                url: '/api/sites/client/scopes',
            });
            expect(scopesResponse.statusCode).toBe(200);
            expect(scopesResponse.json()).toEqual({
                scopes: ['analytics', 'reports'],
                siteId: 'client',
            });

            const diffResponse = await app.inject({
                headers,
                method: 'GET',
                url: '/api/diff',
            });
            expect(diffResponse.statusCode).toBe(200);
            expect(diffResponse.json()).toMatchObject({
                diff: {
                    diffSource: 'base',
                    summary: {
                        changedSites: [
                            {
                                addedScopedGrants: [
                                    {
                                        email: 'reports@example.com',
                                        scopes: ['analytics', 'reports'],
                                    },
                                ],
                                removedFullAccessEmails: ['legacy-admin@example.com'],
                                siteId: 'client',
                            },
                        ],
                        hasChanges: true,
                    },
                },
            });

            const auditResponse = await app.inject({
                headers,
                method: 'GET',
                url: '/api/audit?limit=1',
            });
            expect(auditResponse.statusCode).toBe(200);
            expect(auditResponse.json()).toEqual({
                events: [
                    expect.objectContaining({
                        id: 'evt-2',
                        kind: 'apply-failed',
                    }),
                ],
            });
        } finally {
            await app.close();
        }
    });

    it('returns 404 for unknown managed sites and 400 for invalid audit limits', async () => {
        const tempDirectory = createTempDirectory('magic-sso-manager-api-errors-');
        const settings = createFileBackedSettings(tempDirectory);
        writeFileSync(settings.paths.baseConfigFile, createBaseConfigToml(), 'utf8');

        const app = await buildApp({
            logger: false,
            settings,
        });

        try {
            const headers = {
                authorization: 'Bearer replace-me-with-a-dedicated-long-random-manager-api-token',
            };

            const missingSiteResponse = await app.inject({
                headers,
                method: 'GET',
                url: '/api/sites/missing',
            });
            expect(missingSiteResponse.statusCode).toBe(404);
            expect(missingSiteResponse.json()).toEqual({
                code: 'site_not_found',
                message: 'Managed site missing is not available.',
            });

            const invalidAuditLimitResponse = await app.inject({
                headers,
                method: 'GET',
                url: '/api/audit?limit=0',
            });
            expect(invalidAuditLimitResponse.statusCode).toBe(400);
            expect(invalidAuditLimitResponse.json()).toEqual({
                message: 'Query parameter "limit" must be a positive integer.',
            });
        } finally {
            await app.close();
        }
    });

    it('exports portable state snapshots and reports reconcile previews', async () => {
        const tempDirectory = createTempDirectory('magic-sso-manager-api-reconcile-read-');
        const settings = createFileBackedSettings(tempDirectory);
        writeFileSync(settings.paths.baseConfigFile, createBaseConfigToml(), 'utf8');
        writeFileSync(settings.paths.runtimeConfigFile, createRuntimeConfigToml(), 'utf8');
        writeFileSync(
            settings.paths.stateFile,
            JSON.stringify(
                {
                    version: MANAGER_STATE_VERSION,
                    managedSites: {
                        client: {
                            grants: [
                                {
                                    email: 'Reports@Example.com',
                                    scopes: ['reports'],
                                },
                            ],
                            scopeCatalog: ['reports'],
                        },
                    },
                    metadata: {},
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
            const headers = {
                authorization: 'Bearer replace-me-with-a-dedicated-long-random-manager-api-token',
            };

            const exportResponse = await app.inject({
                headers,
                method: 'GET',
                url: '/api/state/export',
            });
            expect(exportResponse.statusCode).toBe(200);
            expect(exportResponse.json()).toEqual({
                state: {
                    version: 1,
                    managedSites: {
                        client: {
                            grants: [
                                {
                                    email: 'reports@example.com',
                                    scopes: ['reports'],
                                },
                            ],
                            scopeCatalog: ['reports'],
                        },
                    },
                },
            });

            const reconcileResponse = await app.inject({
                headers,
                method: 'GET',
                url: '/api/reconcile',
            });
            expect(reconcileResponse.statusCode).toBe(200);
            expect(reconcileResponse.json()).toMatchObject({
                base: {
                    available: true,
                    preview: {
                        source: 'base',
                    },
                },
                runtime: {
                    available: true,
                    preview: {
                        source: 'runtime',
                    },
                },
            });
        } finally {
            await app.close();
        }
    });
});
