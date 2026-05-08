// SPDX-License-Identifier: GPL-3.0-or-later

import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { afterEach, describe, expect, it, vi } from 'vitest';
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

afterEach(() => {
    for (const directory of tempDirectories) {
        rmSync(directory, { force: true, recursive: true });
    }
    tempDirectories.length = 0;
});

describe('manager service ui diff and apply routes', () => {
    it('validates the current runtime plan from the diff page', async () => {
        const tempDirectory = createTempDirectory('magic-sso-manager-ui-validate-');
        const settings = createFileBackedSettings(tempDirectory);
        writeFileSync(settings.paths.baseConfigFile, createBaseConfigToml(), 'utf8');
        writeValidState(settings);

        const app = await buildApp({
            logger: false,
            settings,
        });

        try {
            const response = await app.inject({
                headers: uiHeaders,
                method: 'POST',
                payload: '',
                url: '/diff/validate',
            });

            expect(response.statusCode).toBe(303);
            expect(response.headers.location).toContain(
                'Validated+runtime+plan+for+1+changed+site.',
            );

            const diffPage = await app.inject({
                headers: {
                    cookie: uiHeaders.cookie,
                },
                method: 'GET',
                url: String(response.headers.location),
            });
            expect(diffPage.statusCode).toBe(200);
            expect(diffPage.body).toContain('Check pending changes');
            expect(diffPage.body).toContain('Publish changes');
            expect(diffPage.body).toContain('Validated runtime plan for 1 changed site.');
        } finally {
            await app.close();
        }
    });

    it('applies pending changes from the diff page and records a browser-session audit actor', async () => {
        const tempDirectory = createTempDirectory('magic-sso-manager-ui-apply-');
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
            const response = await app.inject({
                headers: uiHeaders,
                method: 'POST',
                payload: '',
                url: '/diff/apply',
            });

            expect(response.statusCode).toBe(303);
            expect(response.headers.location).toContain(
                'Applied+runtime+config+and+reloaded+the+server.',
            );
            expect(fetchImplementation).toHaveBeenCalledTimes(1);
            expect(readFileSync(settings.paths.runtimeConfigFile, 'utf8')).toContain(
                'reports@example.com',
            );
            expect(readFileSync(settings.paths.auditFile, 'utf8')).toContain('browser-session');

            const diffPage = await app.inject({
                headers: {
                    cookie: uiHeaders.cookie,
                },
                method: 'GET',
                url: String(response.headers.location),
            });
            expect(diffPage.statusCode).toBe(200);
            expect(diffPage.body).toContain('No managed access changes are pending right now.');
        } finally {
            await app.close();
        }
    });
});
