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
}

afterEach(() => {
    for (const directory of tempDirectories) {
        rmSync(directory, { force: true, recursive: true });
    }
    tempDirectories.length = 0;
});

describe('manager service ui write routes', () => {
    it('adds, updates, and revokes grants through the site editor', async () => {
        const tempDirectory = createTempDirectory('magic-sso-manager-ui-write-access-');
        const settings = createFileBackedSettings(tempDirectory);
        writeFileSync(settings.paths.baseConfigFile, createBaseConfigToml(), 'utf8');
        writeInitialState(settings);

        const app = await buildApp({
            logger: false,
            settings,
        });

        try {
            let response = await app.inject({
                headers: uiHeaders,
                method: 'POST',
                payload:
                    'grantEmail=editor%40example.com&grantMode=scoped&selectedScope0=reports&selectedScope1=analytics',
                url: '/sites/client/access/grants',
            });
            expect(response.statusCode).toBe(303);
            expect(response.headers.location).toContain('Saved+access+for+editor%40example.com.');

            response = await app.inject({
                headers: uiHeaders,
                method: 'POST',
                payload: 'grantEmail=reports%40example.com&grantMode=full-access',
                url: '/sites/client/access/grants',
            });
            expect(response.statusCode).toBe(303);

            response = await app.inject({
                headers: uiHeaders,
                method: 'POST',
                payload: '',
                url: '/sites/client/access/grants/editor@example.com/revoke',
            });
            expect(response.statusCode).toBe(303);

            const savedState = JSON.parse(readFileSync(settings.paths.stateFile, 'utf8')) as {
                managedSites: {
                    client: {
                        grants: Array<{ email: string; scopes: string[] }>;
                    };
                };
            };
            expect(savedState.managedSites.client.grants).toEqual([
                {
                    email: 'reports@example.com',
                    scopes: ['*'],
                },
            ]);

            const auditEvents = readFileSync(settings.paths.auditFile, 'utf8')
                .trim()
                .split('\n')
                .map((line) => JSON.parse(line) as { actor: { user: string }; kind: string });
            expect(auditEvents.map((event) => event.kind)).toEqual([
                'grant-saved',
                'grant-saved',
                'grant-revoked',
            ]);
            expect(auditEvents.every((event) => event.actor.user === 'browser-session')).toBe(true);
        } finally {
            await app.close();
        }
    });

    it('adds and removes catalog scopes with in-use guardrails', async () => {
        const tempDirectory = createTempDirectory('magic-sso-manager-ui-write-scopes-');
        const settings = createFileBackedSettings(tempDirectory);
        writeFileSync(settings.paths.baseConfigFile, createBaseConfigToml(), 'utf8');
        writeInitialState(settings);

        const app = await buildApp({
            logger: false,
            settings,
        });

        try {
            let response = await app.inject({
                headers: uiHeaders,
                method: 'POST',
                payload: 'scopeName=exports',
                url: '/sites/client/scopes',
            });
            expect(response.statusCode).toBe(303);
            expect(response.headers.location).toContain('Added+permission+exports.');

            response = await app.inject({
                headers: uiHeaders,
                method: 'POST',
                payload: '',
                url: '/sites/client/scopes/reports/remove',
            });
            expect(response.statusCode).toBe(409);
            expect(response.body).toContain('Scope reports is still assigned on client.');

            response = await app.inject({
                headers: uiHeaders,
                method: 'POST',
                payload: '',
                url: '/sites/client/scopes/exports/remove',
            });
            expect(response.statusCode).toBe(303);

            const savedState = JSON.parse(readFileSync(settings.paths.stateFile, 'utf8')) as {
                managedSites: {
                    client: {
                        scopeCatalog: string[];
                    };
                };
            };
            expect(savedState.managedSites.client.scopeCatalog).toEqual(['analytics', 'reports']);

            const auditEvents = readFileSync(settings.paths.auditFile, 'utf8')
                .trim()
                .split('\n')
                .map((line) => JSON.parse(line) as { kind: string });
            expect(auditEvents.map((event) => event.kind)).toEqual([
                'scope-added',
                'scope-removed',
            ]);
        } finally {
            await app.close();
        }
    });

    it('reopens the right access editor when validation fails', async () => {
        const tempDirectory = createTempDirectory('magic-sso-manager-ui-write-errors-');
        const settings = createFileBackedSettings(tempDirectory);
        writeFileSync(settings.paths.baseConfigFile, createBaseConfigToml(), 'utf8');
        writeInitialState(settings);

        const app = await buildApp({
            logger: false,
            settings,
        });

        try {
            let response = await app.inject({
                headers: uiHeaders,
                method: 'POST',
                payload: 'grantMode=scoped&selectedScope0=reports',
                url: '/sites/client/access/grants',
            });
            expect(response.statusCode).toBe(400);
            expect(response.body).toContain('Email is required.');
            expect(response.body).toContain('data-editor-kind="new" open');
            expect(response.body).toContain('name="selectedScope0"');
            expect(response.body).toContain('value="reports"');
            expect(response.body).toContain('checked');

            response = await app.inject({
                headers: uiHeaders,
                method: 'POST',
                payload: 'grantEmail=reports%40example.com&grantMode=scoped',
                url: '/sites/client/access/grants',
            });
            expect(response.statusCode).toBe(400);
            expect(response.body).toContain(
                'Limited access requires at least one selected permission.',
            );
            expect(response.body).toContain('data-grant-email="reports@example.com" open');
            expect(response.body).toContain('value="reports@example.com"');
        } finally {
            await app.close();
        }
    });
});
