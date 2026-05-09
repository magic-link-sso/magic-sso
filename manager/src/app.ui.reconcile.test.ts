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

function writeInitialState(settings: ManagerRuntimeSettings): void {
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
                    lastAppliedAt: '2026-05-02T10:00:00.000Z',
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

describe('manager service ui reconcile routes', () => {
    it('renders reconcile previews, export json, and import tools', async () => {
        const tempDirectory = createTempDirectory('magic-sso-manager-ui-reconcile-');
        const settings = createFileBackedSettings(tempDirectory);
        writeFileSync(settings.paths.baseConfigFile, createBaseConfigToml(), 'utf8');
        writeFileSync(settings.paths.runtimeConfigFile, createRuntimeConfigToml(), 'utf8');
        writeInitialState(settings);

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
                url: '/reconcile',
            });

            expect(response.statusCode).toBe(200);
            expect(response.body).toContain('Sync Access State');
            expect(response.body).toContain('/reconcile/base');
            expect(response.body).toContain('/reconcile/runtime');
            expect(response.body).toContain('/reconcile/import');
            expect(response.body).toContain('Portable export');
            expect(response.body).toContain('reports@example.com');
            expect(response.body).toContain('Snapshot JSON');
            expect(response.body).toContain('datetime="2026-05-02T10:00:00.000Z"');
            expect(response.body).toContain('2026-05-02 10:00 UTC');
        } finally {
            await app.close();
        }
    });

    it('imports portable snapshots and reconciles from base config through the browser flow', async () => {
        const tempDirectory = createTempDirectory('magic-sso-manager-ui-reconcile-write-');
        const settings = createFileBackedSettings(tempDirectory);
        writeFileSync(settings.paths.baseConfigFile, createBaseConfigToml(), 'utf8');
        writeInitialState(settings);
        const snapshotJson = JSON.stringify({
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
        });

        const app = await buildApp({
            logger: false,
            settings,
        });

        try {
            let response = await app.inject({
                headers: uiHeaders,
                method: 'POST',
                payload: `snapshotJson=${encodeURIComponent(snapshotJson)}`,
                url: '/reconcile/import',
            });
            expect(response.statusCode).toBe(303);
            expect(response.headers.location).toContain(
                'Imported+portable+manager+state+and+reset+apply+metadata.',
            );
            expect(JSON.parse(readFileSync(settings.paths.stateFile, 'utf8'))).toEqual({
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
                metadata: {},
            });

            response = await app.inject({
                headers: uiHeaders,
                method: 'POST',
                payload: '',
                url: '/reconcile/base',
            });
            expect(response.statusCode).toBe(303);
            expect(response.headers.location).toContain(
                'Reconciled+manager+state+from+the+base+config+and+reset+apply+metadata.',
            );
            expect(JSON.parse(readFileSync(settings.paths.stateFile, 'utf8'))).toEqual({
                version: 1,
                managedSites: {
                    client: {
                        grants: [
                            {
                                email: 'legacy-admin@example.com',
                                scopes: ['*'],
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
                .map((line) => JSON.parse(line) as { kind: string });
            expect(auditEvents.map((event) => event.kind)).toEqual([
                'state-imported',
                'state-reconciled',
            ]);
        } finally {
            await app.close();
        }
    });

    it('renders import validation failures and preserves the submitted snapshot text', async () => {
        const tempDirectory = createTempDirectory('magic-sso-manager-ui-reconcile-errors-');
        const settings = createFileBackedSettings(tempDirectory);
        writeFileSync(settings.paths.baseConfigFile, createBaseConfigToml(), 'utf8');
        writeInitialState(settings);

        const app = await buildApp({
            logger: false,
            settings,
        });

        try {
            const response = await app.inject({
                headers: uiHeaders,
                method: 'POST',
                payload: 'snapshotJson=not-json',
                url: '/reconcile/import',
            });
            expect(response.statusCode).toBe(400);
            expect(response.body).toContain(
                'Failed to parse portable manager state snapshot (UI import form)',
            );
            expect(response.body).toContain('not-json');
        } finally {
            await app.close();
        }
    });
});
