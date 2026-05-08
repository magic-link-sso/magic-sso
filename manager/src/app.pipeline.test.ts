// SPDX-License-Identifier: GPL-3.0-or-later

import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { buildApp } from './app.js';
import { MANAGER_STATE_VERSION } from './state.js';
import { type ManagerRuntimeSettings } from './settings.js';

const tempDirectories: string[] = [];
const authHeader = {
    authorization: 'Bearer replace-me-with-a-dedicated-long-random-manager-api-token',
};

function createSettings(
    overrides: Partial<ManagerRuntimeSettings> = {},
    reloadOverrides?: ManagerRuntimeSettings['reload'],
): ManagerRuntimeSettings {
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
        reload: reloadOverrides,
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

function createTempDirectory(prefix: string): string {
    const tempDirectory = mkdtempSync(join(tmpdir(), prefix));
    tempDirectories.push(tempDirectory);
    return tempDirectory;
}

function createFileBackedSettings(
    tempDirectory: string,
    reloadOverrides?: ManagerRuntimeSettings['reload'],
): ManagerRuntimeSettings {
    return createSettings(
        {
            configFilePath: join(tempDirectory, 'manager', 'manager.toml'),
            paths: {
                auditFile: join(tempDirectory, 'manager-audit.ndjson'),
                baseConfigFile: join(tempDirectory, 'magic-sso.base.toml'),
                lastGoodRuntimeConfigFile: join(tempDirectory, 'magic-sso.runtime.last-good.toml'),
                lockFile: join(tempDirectory, 'manager.lock'),
                runtimeConfigFile: join(tempDirectory, 'magic-sso.runtime.toml'),
                stateFile: join(tempDirectory, 'manager-state.json'),
            },
        },
        reloadOverrides,
    );
}

function writeValidState(settings: ManagerRuntimeSettings): void {
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
}

function writeDriftedState(settings: ManagerRuntimeSettings): void {
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
                                scopes: ['reports'],
                            },
                        ],
                        scopeCatalog: ['reports'],
                    },
                },
                metadata: {
                    lastAppliedBaseConfigHash: 'stale-base-hash',
                    lastAppliedRuntimeConfigHash: 'stale-runtime-hash',
                },
            },
            null,
            2,
        ),
        'utf8',
    );
}

afterEach(() => {
    for (const directory of tempDirectories) {
        rmSync(directory, { force: true, recursive: true });
    }
    tempDirectories.length = 0;
});

describe('manager service pipeline endpoints', () => {
    it('validates the rendered runtime plan', async () => {
        const tempDirectory = createTempDirectory('magic-sso-manager-api-validate-');
        const settings = createFileBackedSettings(tempDirectory);
        writeFileSync(settings.paths.baseConfigFile, createBaseConfigToml(), 'utf8');
        writeValidState(settings);

        const app = await buildApp({
            logger: false,
            settings,
        });

        try {
            const response = await app.inject({
                headers: authHeader,
                method: 'POST',
                url: '/api/validate',
            });

            expect(response.statusCode).toBe(200);
            expect(response.json()).toMatchObject({
                validation: {
                    diff: {
                        summary: {
                            hasChanges: true,
                        },
                    },
                    runtimeConfigFile: settings.paths.runtimeConfigFile,
                    valid: true,
                },
            });
        } finally {
            await app.close();
        }
    });

    it('keeps bearer-token API mutations working without an Origin header', async () => {
        const tempDirectory = createTempDirectory('magic-sso-manager-api-bearer-origin-');
        const settings = createFileBackedSettings(tempDirectory);
        writeFileSync(settings.paths.baseConfigFile, createBaseConfigToml(), 'utf8');

        const app = await buildApp({
            logger: false,
            settings,
        });

        try {
            const response = await app.inject({
                headers: authHeader,
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

    it('returns actionable validation errors when the runtime candidate is invalid', async () => {
        const tempDirectory = createTempDirectory('magic-sso-manager-api-validate-error-');
        const settings = createFileBackedSettings(tempDirectory);
        writeFileSync(settings.paths.baseConfigFile, createBaseConfigToml(), 'utf8');

        const app = await buildApp({
            logger: false,
            settings,
        });

        try {
            const response = await app.inject({
                headers: authHeader,
                method: 'POST',
                url: '/api/validate',
            });

            expect(response.statusCode).toBe(400);
            expect(response.json()).toMatchObject({
                code: 'runtime_validation_failed',
                details: {
                    runtimeConfigFile: settings.paths.runtimeConfigFile,
                },
            });
            expect(String(response.json().message)).toContain(
                'Each site must define allowedEmails, accessRules, or both.',
            );
        } finally {
            await app.close();
        }
    });

    it('applies state, writes audit data, and proxies reload requests', async () => {
        const tempDirectory = createTempDirectory('magic-sso-manager-api-apply-');
        const settings = createFileBackedSettings(tempDirectory, {
            secret: 'manager-reload-secret-0123456789abcdefghij',
            timeoutMs: 5_000,
            url: 'http://127.0.0.1:3000/internal/access-config/reload',
        });
        writeFileSync(settings.paths.baseConfigFile, createBaseConfigToml(), 'utf8');
        writeValidState(settings);

        const fetchImplementation = vi.fn<typeof fetch>(async () => {
            return new Response(JSON.stringify({ changedSiteIds: ['client'], reloaded: true }), {
                headers: {
                    'content-type': 'application/json',
                },
                status: 200,
            });
        });

        const app = await buildApp({
            fetchImplementation,
            logger: false,
            now: new Date('2026-05-02T12:00:00.000Z'),
            settings,
        });

        try {
            const applyResponse = await app.inject({
                headers: authHeader,
                method: 'POST',
                url: '/api/apply',
            });

            expect(applyResponse.statusCode).toBe(200);
            expect(applyResponse.json()).toMatchObject({
                apply: {
                    auditEvent: {
                        actor: {
                            user: 'internal-bearer-token',
                        },
                        kind: 'apply-succeeded',
                    },
                    auditPersisted: true,
                    reloadResult: {
                        changedSiteIds: ['client'],
                        reloaded: true,
                    },
                    runtimeConfigFile: settings.paths.runtimeConfigFile,
                },
            });
            expect(readFileSync(settings.paths.runtimeConfigFile, 'utf8')).toContain('reports');
            expect(readFileSync(settings.paths.auditFile, 'utf8')).toContain(
                'internal-bearer-token',
            );

            const reloadResponse = await app.inject({
                headers: authHeader,
                method: 'POST',
                url: '/api/reload',
            });
            expect(reloadResponse.statusCode).toBe(200);
            expect(reloadResponse.json()).toEqual({
                reload: {
                    changedSiteIds: ['client'],
                    reloaded: true,
                },
            });

            expect(fetchImplementation).toHaveBeenCalledTimes(2);
        } finally {
            await app.close();
        }
    });

    it('returns structured errors when reload support is not configured', async () => {
        const tempDirectory = createTempDirectory('magic-sso-manager-api-reload-error-');
        const settings = createFileBackedSettings(tempDirectory);
        writeFileSync(settings.paths.baseConfigFile, createBaseConfigToml(), 'utf8');
        writeValidState(settings);

        const app = await buildApp({
            logger: false,
            settings,
        });

        try {
            const response = await app.inject({
                headers: authHeader,
                method: 'POST',
                url: '/api/reload',
            });

            expect(response.statusCode).toBe(400);
            expect(response.json()).toEqual({
                code: 'reload_not_configured',
                message:
                    'Manager reload target is not configured. Add [reload] to MAGICSSO_MANAGER_CONFIG_FILE.',
            });
        } finally {
            await app.close();
        }
    });

    it('freezes access and scope mutation APIs when the base config has drifted', async () => {
        const tempDirectory = createTempDirectory('magic-sso-manager-api-drift-freeze-');
        const settings = createFileBackedSettings(tempDirectory);
        writeFileSync(settings.paths.baseConfigFile, createBaseConfigToml(), 'utf8');
        writeDriftedState(settings);

        const app = await buildApp({
            logger: false,
            settings,
        });

        try {
            const mutationRequests = [
                {
                    method: 'PUT' as const,
                    payload: {
                        grants: [
                            {
                                email: 'viewer@example.com',
                                scopes: ['reports'],
                            },
                        ],
                    },
                    url: '/api/sites/client/access',
                },
                {
                    method: 'POST' as const,
                    payload: {
                        email: 'viewer@example.com',
                        scopes: ['reports'],
                    },
                    url: '/api/sites/client/access/grants',
                },
                {
                    method: 'PATCH' as const,
                    payload: {
                        scopes: ['reports'],
                    },
                    url: '/api/sites/client/access/grants/reports@example.com',
                },
                {
                    method: 'DELETE' as const,
                    url: '/api/sites/client/access/grants/reports@example.com',
                },
                {
                    method: 'PUT' as const,
                    payload: {
                        scopes: ['exports', 'reports'],
                    },
                    url: '/api/sites/client/scopes',
                },
                {
                    method: 'POST' as const,
                    payload: {
                        scope: 'exports',
                    },
                    url: '/api/sites/client/scopes',
                },
                {
                    method: 'DELETE' as const,
                    url: '/api/sites/client/scopes/reports',
                },
            ];

            for (const request of mutationRequests) {
                const response = await app.inject({
                    headers: authHeader,
                    method: request.method,
                    payload: request.payload,
                    url: request.url,
                });

                expect(response.statusCode).toBe(409);
                expect(response.json()).toEqual({
                    code: 'base_config_drift',
                    message:
                        'Base config drift detected. Manager access mutations are frozen until magic-sso.base.toml is synced and applied again.',
                });
            }

            expect(
                JSON.parse(readFileSync(settings.paths.stateFile, 'utf8')) as {
                    managedSites: {
                        client: {
                            grants: Array<{ email: string; scopes: string[] }>;
                            scopeCatalog: string[];
                        };
                    };
                },
            ).toMatchObject({
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
            });
        } finally {
            await app.close();
        }
    });

    it('keeps recovery APIs available during base config drift', async () => {
        const tempDirectory = createTempDirectory('magic-sso-manager-api-drift-recovery-');
        const settings = createFileBackedSettings(tempDirectory);
        writeFileSync(settings.paths.baseConfigFile, createBaseConfigToml(), 'utf8');
        writeDriftedState(settings);

        const app = await buildApp({
            logger: false,
            settings,
        });

        try {
            const importResponse = await app.inject({
                headers: authHeader,
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
            });

            const reconcileResponse = await app.inject({
                headers: authHeader,
                method: 'POST',
                url: '/api/reconcile/base',
            });
            expect(reconcileResponse.statusCode).toBe(200);
            expect(reconcileResponse.json()).toMatchObject({
                source: 'base',
            });
        } finally {
            await app.close();
        }
    });
});
