// SPDX-License-Identifier: GPL-3.0-or-later

import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { afterEach, describe, expect, it } from 'vitest';
import { buildApp, MANAGER_SESSION_COOKIE_NAME } from './app.js';
import { MANAGER_STATE_VERSION } from './state.js';
import { type ManagerRuntimeSettings } from './settings.js';

const tempDirectories: string[] = [];
const managerToken = 'replace-me-with-a-dedicated-long-random-manager-api-token';
const uiHeaders = {
    cookie: `${MANAGER_SESSION_COOKIE_NAME}=${encodeURIComponent(managerToken)}`,
    host: 'manager.example.test',
    origin: 'http://manager.example.test',
    'content-type': 'application/x-www-form-urlencoded',
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
                bearerToken: managerToken,
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

describe('manager service drift-aware ui routes', () => {
    it('freezes site edits and apply actions when the base config has drifted', async () => {
        const tempDirectory = createTempDirectory('magic-sso-manager-ui-drift-');
        const settings = createFileBackedSettings(tempDirectory);
        writeFileSync(settings.paths.baseConfigFile, createBaseConfigToml(), 'utf8');
        writeDriftedState(settings);

        const app = await buildApp({
            logger: false,
            settings,
        });

        try {
            const siteResponse = await app.inject({
                headers: {
                    cookie: uiHeaders.cookie,
                },
                method: 'GET',
                url: '/sites/client',
            });
            expect(siteResponse.statusCode).toBe(200);
            expect(siteResponse.body).toContain('UI write actions are frozen');
            expect(siteResponse.body).toContain(
                'access edits are temporarily frozen until the operator syncs the base config',
            );

            const diffResponse = await app.inject({
                headers: {
                    cookie: uiHeaders.cookie,
                },
                method: 'GET',
                url: '/diff',
            });
            expect(diffResponse.statusCode).toBe(200);
            expect(diffResponse.body).toContain(
                'Publish is disabled until the base config drift is synced.',
            );

            const mutateResponse = await app.inject({
                headers: uiHeaders,
                method: 'POST',
                payload: 'scopeName=exports',
                url: '/sites/client/scopes',
            });
            expect(mutateResponse.statusCode).toBe(409);
            expect(mutateResponse.body).toContain(
                'UI write actions are frozen until magic-sso.base.toml is synced and applied again.',
            );

            const savedState = JSON.parse(readFileSync(settings.paths.stateFile, 'utf8')) as {
                managedSites: {
                    client: {
                        scopeCatalog: string[];
                    };
                };
            };
            expect(savedState.managedSites.client.scopeCatalog).toEqual(['reports']);
        } finally {
            await app.close();
        }
    });

    it('renders audit summaries, status badges, and hash previews', async () => {
        const tempDirectory = createTempDirectory('magic-sso-manager-ui-audit-');
        const settings = createFileBackedSettings(tempDirectory);
        writeFileSync(settings.paths.baseConfigFile, createBaseConfigToml(), 'utf8');
        writeDriftedState(settings);
        writeFileSync(
            settings.paths.auditFile,
            [
                JSON.stringify({
                    actor: {
                        host: 'manager-host',
                        siteId: 'manager-admin',
                        user: 'operator',
                    },
                    baseConfigHash: 'base-1-hash-preview',
                    changedSiteIds: ['client'],
                    id: 'evt-1',
                    kind: 'grant-saved',
                    message: 'Saved grant for reports@example.com on client.',
                    reloaded: false,
                    rolledBack: false,
                    runtimeConfigHash: 'runtime-1-hash-preview',
                    stateHash: 'state-1-hash-preview',
                    timestamp: '2026-05-02T10:05:00.000Z',
                }),
                JSON.stringify({
                    actor: {
                        host: 'manager-host',
                        user: 'operator',
                    },
                    baseConfigHash: 'base-2-hash-preview',
                    changedSiteIds: [],
                    driftStatus: {
                        baseConfigDrifted: true,
                        currentBaseConfigHash: 'current-base-hash',
                        currentRuntimeConfigHash: 'current-runtime-hash',
                        expectedBaseConfigHash: 'expected-base-hash',
                        expectedRuntimeConfigHash: 'expected-runtime-hash',
                        runtimeConfigDrifted: true,
                        runtimeConfigExists: false,
                    },
                    id: 'evt-2',
                    kind: 'apply-failed',
                    message: 'Server reload failed.',
                    reloaded: false,
                    rolledBack: true,
                    runtimeConfigHash: 'runtime-2-hash-preview',
                    stateHash: 'state-2-hash-preview',
                    timestamp: '2026-05-02T10:10:00.000Z',
                }),
            ].join('\n'),
            'utf8',
        );

        const app = await buildApp({
            logger: false,
            settings,
        });

        try {
            const response = await app.inject({
                headers: {
                    cookie: uiHeaders.cookie,
                },
                method: 'GET',
                url: '/audit',
            });

            expect(response.statusCode).toBe(200);
            expect(response.body).toContain('Audit summary');
            expect(response.body).toContain('Failed applies');
            expect(response.body).toContain('Reloaded');
            expect(response.body).toContain('Rolled back');
            expect(response.body).toContain('Drift snapshot');
            expect(response.body).toContain('Base hash');
            expect(response.body).toContain('Runtime hash');
            expect(response.body).toContain('State hash');
            expect(response.body).toContain('class="hash-list event-facts"');
            expect(response.body).toContain(
                'grid-template-columns: minmax(0, 1.45fr) repeat(3, minmax(0, 1fr));',
            );
            expect(response.body).toContain('via manager-admin');
            expect(response.body).toContain('grant-saved');
        } finally {
            await app.close();
        }
    });
});
