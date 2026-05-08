// SPDX-License-Identifier: GPL-3.0-or-later

import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
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
                mode: 'gate',
                requiredScope: '*',
                requiredSiteId: 'manager-admin',
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
id = "client"
origins = ["http://client.example.com"]
allowedRedirectUris = ["http://client.example.com/verify-email", "http://client.example.com/*"]
allowedEmails = ["legacy-admin@example.com"]
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

function createGateHeaders(overrides: Record<string, string> = {}): Record<string, string> {
    return {
        'x-magic-sso-site-id': 'manager-admin',
        'x-magic-sso-user-email': 'operator@example.com',
        'x-magic-sso-user-scope': '*',
        ...overrides,
    };
}

function createGateMutationHeaders(overrides: Record<string, string> = {}): Record<string, string> {
    return createGateHeaders({
        host: 'manager.example.test',
        origin: 'http://manager.example.test',
        ...overrides,
    });
}

afterEach(() => {
    for (const directory of tempDirectories) {
        rmSync(directory, { force: true, recursive: true });
    }
    tempDirectories.length = 0;
});

describe('manager service Gate auth', () => {
    it('protects api routes with the configured Gate site and scope requirements', async () => {
        const tempDirectory = createTempDirectory('magic-sso-manager-gate-auth-');
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
                message: 'Missing or invalid Gate identity headers.',
            });

            const forbiddenResponse = await app.inject({
                headers: createGateHeaders({
                    'x-magic-sso-site-id': 'client',
                }),
                method: 'GET',
                url: '/api/sites',
            });
            expect(forbiddenResponse.statusCode).toBe(403);
            expect(forbiddenResponse.json()).toEqual({
                message: 'Forbidden',
            });

            const authorizedResponse = await app.inject({
                headers: createGateHeaders(),
                method: 'GET',
                url: '/api/sites',
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

    it('serves the UI directly from Gate-forwarded identity without the temporary login screen', async () => {
        const tempDirectory = createTempDirectory('magic-sso-manager-gate-ui-');
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
                                    email: 'operator@example.com',
                                    scopes: ['*'],
                                },
                            ],
                            scopeCatalog: [],
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
            const directUiResponse = await app.inject({
                method: 'GET',
                url: '/',
            });
            expect(directUiResponse.statusCode).toBe(401);
            expect(directUiResponse.body).toContain('Missing or invalid Gate identity headers.');

            const gateUiResponse = await app.inject({
                headers: createGateHeaders(),
                method: 'GET',
                url: '/',
            });
            expect(gateUiResponse.statusCode).toBe(200);
            expect(gateUiResponse.body).toContain('Operations Dashboard');
            expect(gateUiResponse.body).toContain('action="/_magicgate/logout"');

            const reconcileUiResponse = await app.inject({
                headers: createGateHeaders(),
                method: 'GET',
                url: '/reconcile',
            });
            expect(reconcileUiResponse.statusCode).toBe(200);
            expect(reconcileUiResponse.body).toContain('Sync Access State');

            const loginRouteResponse = await app.inject({
                method: 'GET',
                url: '/login',
            });
            expect(loginRouteResponse.statusCode).toBe(404);
        } finally {
            await app.close();
        }
    });

    it('allows Gate-authenticated admins to use read and write API endpoints', async () => {
        const tempDirectory = createTempDirectory('magic-sso-manager-gate-api-');
        const settings = createFileBackedSettings(tempDirectory);
        writeFileSync(settings.paths.baseConfigFile, createBaseConfigToml(), 'utf8');

        const app = await buildApp({
            logger: false,
            settings,
        });

        try {
            const headers = createGateHeaders();

            let response = await app.inject({
                headers,
                method: 'GET',
                url: '/api/sites',
            });
            expect(response.statusCode).toBe(200);
            expect(response.json()).toEqual({
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

            response = await app.inject({
                headers: createGateMutationHeaders(),
                method: 'POST',
                payload: {
                    scope: 'reports',
                },
                url: '/api/sites/client/scopes',
            });
            expect(response.statusCode).toBe(200);
            expect(response.json()).toMatchObject({
                site: {
                    id: 'client',
                    scopeCatalog: ['reports'],
                },
            });

            response = await app.inject({
                headers: createGateMutationHeaders(),
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

            const savedState = JSON.parse(readFileSync(settings.paths.stateFile, 'utf8')) as {
                managedSites: {
                    client: {
                        grants: Array<{ email: string; scopes: string[] }>;
                        scopeCatalog: string[];
                    };
                };
            };
            expect(savedState.managedSites.client).toEqual({
                grants: [
                    {
                        email: 'reports@example.com',
                        scopes: ['reports'],
                    },
                ],
                scopeCatalog: ['reports'],
            });

            const auditEvents = readFileSync(settings.paths.auditFile, 'utf8')
                .trim()
                .split('\n')
                .map(
                    (line) =>
                        JSON.parse(line) as {
                            actor: { siteId?: string; user: string };
                            kind: string;
                        },
                );
            expect(auditEvents.map((event) => event.kind)).toEqual(['scope-added', 'grant-saved']);
            expect(auditEvents).toMatchObject([
                {
                    actor: {
                        siteId: 'manager-admin',
                        user: 'operator@example.com',
                    },
                },
                {
                    actor: {
                        siteId: 'manager-admin',
                        user: 'operator@example.com',
                    },
                },
            ]);
        } finally {
            await app.close();
        }
    });

    it('rejects Gate-authenticated unsafe API requests from a different origin', async () => {
        const tempDirectory = createTempDirectory('magic-sso-manager-gate-origin-');
        const settings = createFileBackedSettings(tempDirectory);
        writeFileSync(settings.paths.baseConfigFile, createBaseConfigToml(), 'utf8');

        const app = await buildApp({
            logger: false,
            settings,
        });

        try {
            const response = await app.inject({
                headers: createGateMutationHeaders({
                    origin: 'https://evil.example.test',
                    'x-forwarded-host': 'evil.example.test',
                    'x-forwarded-proto': 'https',
                }),
                method: 'POST',
                payload: {
                    scope: 'reports',
                },
                url: '/api/sites/client/scopes',
            });

            expect(response.statusCode).toBe(403);
            expect(response.json()).toEqual({
                code: 'invalid_api_origin',
                message: 'Manager API mutations require a same-origin browser request.',
            });
        } finally {
            await app.close();
        }
    });

    it('accepts Gate-authenticated API writes through a trusted proxy', async () => {
        const tempDirectory = createTempDirectory('magic-sso-manager-gate-trust-proxy-');
        const settings = createFileBackedSettings(tempDirectory);
        writeFileSync(settings.paths.baseConfigFile, createBaseConfigToml(), 'utf8');

        const app = await buildApp({
            logger: false,
            settings: {
                ...settings,
                service: {
                    auth: {
                        mode: 'gate',
                        requiredScope: '*',
                        requiredSiteId: 'manager-admin',
                    },
                    host: '127.0.0.1',
                    port: 4311,
                    trustProxy: true,
                },
            },
        });

        try {
            const response = await app.inject({
                headers: createGateHeaders({
                    host: 'manager.internal.test:4311',
                    origin: 'https://manager.example.test',
                    'x-forwarded-host': 'manager.example.test',
                    'x-forwarded-proto': 'https',
                }),
                method: 'POST',
                payload: {
                    scope: 'reports',
                },
                url: '/api/sites/client/scopes',
            });

            expect(response.statusCode).toBe(200);
            expect(response.json()).toMatchObject({
                site: {
                    id: 'client',
                    scopeCatalog: ['reports'],
                },
            });
        } finally {
            await app.close();
        }
    });

    it('rejects Gate-authenticated API writes when the forwarded scope is not authorized', async () => {
        const tempDirectory = createTempDirectory('magic-sso-manager-gate-forbidden-');
        const settings = createFileBackedSettings(tempDirectory);
        writeFileSync(settings.paths.baseConfigFile, createBaseConfigToml(), 'utf8');

        const restrictedSettings = {
            ...settings,
            service: {
                auth: {
                    mode: 'gate',
                    requiredScope: 'manager:admin',
                    requiredSiteId: 'manager-admin',
                },
                host: '127.0.0.1',
                port: 4311,
            },
        } satisfies ManagerRuntimeSettings;

        const app = await buildApp({
            logger: false,
            settings: restrictedSettings,
        });

        try {
            const response = await app.inject({
                headers: createGateMutationHeaders({
                    'x-magic-sso-user-scope': 'reports',
                }),
                method: 'POST',
                payload: {
                    scope: 'reports',
                },
                url: '/api/sites/client/scopes',
            });

            expect(response.statusCode).toBe(403);
            expect(response.json()).toEqual({
                message: 'Forbidden',
            });
        } finally {
            await app.close();
        }
    });

    it('allows Gate-authenticated admins to import portable state and inspect reconcile status', async () => {
        const tempDirectory = createTempDirectory('magic-sso-manager-gate-import-');
        const settings = createFileBackedSettings(tempDirectory);
        writeFileSync(settings.paths.baseConfigFile, createBaseConfigToml(), 'utf8');

        const app = await buildApp({
            logger: false,
            settings,
        });

        try {
            const headers = createGateHeaders();

            const importResponse = await app.inject({
                headers: createGateMutationHeaders(),
                method: 'POST',
                payload: {
                    state: {
                        version: MANAGER_STATE_VERSION,
                        managedSites: {
                            client: {
                                grants: [
                                    {
                                        email: 'operator@example.com',
                                        scopes: ['*'],
                                    },
                                ],
                                scopeCatalog: ['reports'],
                            },
                        },
                    },
                },
                url: '/api/state/import',
            });
            expect(importResponse.statusCode).toBe(200);
            expect(importResponse.json()).toMatchObject({
                changedSiteIds: ['client'],
                state: {
                    managedSites: {
                        client: {
                            grants: [
                                {
                                    email: 'operator@example.com',
                                    scopes: ['*'],
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
            });

            const auditEvents = readFileSync(settings.paths.auditFile, 'utf8')
                .trim()
                .split('\n')
                .map((line) => JSON.parse(line) as { actor: { siteId?: string; user: string } });
            expect(auditEvents[0]?.actor).toMatchObject({
                siteId: 'manager-admin',
                user: 'operator@example.com',
            });
        } finally {
            await app.close();
        }
    });
});
