// SPDX-License-Identifier: GPL-3.0-or-later

import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { afterEach, describe, expect, it } from 'vitest';
import { buildApp, MANAGER_SESSION_COOKIE_NAME } from './app.js';
import { MANAGER_STATE_VERSION } from './state.js';
import { type ManagerRuntimeSettings } from './settings.js';

const tempDirectories: string[] = [];
const managerToken = 'replace-me-with-a-dedicated-long-random-manager-api-token';

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

function createSessionCookie(): string {
    return `${MANAGER_SESSION_COOKIE_NAME}=${encodeURIComponent(managerToken)}`;
}

afterEach(() => {
    for (const directory of tempDirectories) {
        rmSync(directory, { force: true, recursive: true });
    }
    tempDirectories.length = 0;
});

describe('manager service ui routes', () => {
    it('redirects unauthenticated page requests to the login screen', async () => {
        const app = await buildApp({
            logger: false,
            settings: createSettings(),
        });

        try {
            const response = await app.inject({
                method: 'GET',
                url: '/',
            });

            expect(response.statusCode).toBe(303);
            expect(response.headers.location).toBe('/login?returnTo=%2F');
        } finally {
            await app.close();
        }
    });

    it('renders the login page and accepts the configured manager token', async () => {
        const app = await buildApp({
            logger: false,
            settings: createSettings(),
        });

        try {
            const loginPage = await app.inject({
                method: 'GET',
                url: '/login?returnTo=%2Fdiff',
            });
            expect(loginPage.statusCode).toBe(200);
            expect(loginPage.body).toContain('Unlock dashboard');
            expect(loginPage.body).toContain('returnTo');
            expect(loginPage.body).toContain('color-scheme: light dark;');
            expect(loginPage.body).toContain('@media (prefers-color-scheme: dark)');
            expect(loginPage.body).toContain('--field-bg: rgba(255, 248, 240, 0.08);');
            expect(loginPage.body).toContain('background: var(--field-bg);');
            expect(loginPage.headers['content-security-policy']).toBe(
                "default-src 'none'; style-src 'unsafe-inline'; script-src 'unsafe-inline'; form-action 'self'; frame-ancestors 'none'; base-uri 'none'",
            );

            const loginResponse = await app.inject({
                headers: {
                    host: 'manager.example.test',
                    origin: 'http://manager.example.test',
                    'content-type': 'application/x-www-form-urlencoded',
                },
                method: 'POST',
                payload:
                    'managerToken=replace-me-with-a-dedicated-long-random-manager-api-token&returnTo=%2Fdiff',
                url: '/login',
            });

            expect(loginResponse.statusCode).toBe(303);
            expect(loginResponse.headers.location).toBe('/diff');
            expect(String(loginResponse.headers['set-cookie'])).toContain(
                `${MANAGER_SESSION_COOKIE_NAME}=`,
            );
            expect(String(loginResponse.headers['set-cookie'])).toContain('Max-Age=28800');
        } finally {
            await app.close();
        }
    });

    it('accepts proxied login submissions only when trustProxy is enabled', async () => {
        const app = await buildApp({
            logger: false,
            settings: createSettings({
                service: {
                    auth: {
                        bearerToken: managerToken,
                    },
                    host: '127.0.0.1',
                    port: 4311,
                    trustProxy: true,
                },
            }),
        });

        try {
            const response = await app.inject({
                headers: {
                    host: 'manager.internal.test:4311',
                    origin: 'https://manager.example.test',
                    'content-type': 'application/x-www-form-urlencoded',
                    'x-forwarded-host': 'manager.example.test',
                    'x-forwarded-proto': 'https',
                },
                method: 'POST',
                payload:
                    'managerToken=replace-me-with-a-dedicated-long-random-manager-api-token&returnTo=%2F',
                url: '/login',
            });

            expect(response.statusCode).toBe(303);
            expect(String(response.headers['set-cookie'])).toContain('Secure');
            expect(String(response.headers['set-cookie'])).toContain('Max-Age=28800');
        } finally {
            await app.close();
        }
    });

    it('rate limits repeated login attempts from the same client IP', async () => {
        const app = await buildApp({
            logger: false,
            settings: createSettings(),
        });

        try {
            for (let attempt = 0; attempt < 5; attempt += 1) {
                const response = await app.inject({
                    headers: {
                        host: 'manager.example.test',
                        origin: 'http://manager.example.test',
                        'content-type': 'application/x-www-form-urlencoded',
                        'x-forwarded-for': `203.0.113.${attempt + 1}`,
                    },
                    method: 'POST',
                    payload: 'managerToken=wrong-token&returnTo=%2F',
                    remoteAddress: '198.51.100.10',
                    url: '/login',
                });

                expect(response.statusCode).toBe(403);
            }

            const limitedResponse = await app.inject({
                headers: {
                    host: 'manager.example.test',
                    origin: 'http://manager.example.test',
                    'content-type': 'application/x-www-form-urlencoded',
                    'x-forwarded-for': '203.0.113.250',
                },
                method: 'POST',
                payload: 'managerToken=wrong-token&returnTo=%2F',
                remoteAddress: '198.51.100.10',
                url: '/login',
            });

            expect(limitedResponse.statusCode).toBe(429);
            expect(String(limitedResponse.headers['retry-after'] ?? '')).not.toBe('');
            expect(limitedResponse.body).toContain('Too many requests.');
        } finally {
            await app.close();
        }
    });

    it('renders dashboard, site detail, diff, and audit pages from manager state', async () => {
        const tempDirectory = createTempDirectory('magic-sso-manager-ui-');
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
                                    email: 'admin@example.com',
                                    scopes: ['*'],
                                },
                                {
                                    email: 'reports@example.com',
                                    scopes: ['analytics', 'reports'],
                                },
                            ],
                            scopeCatalog: ['analytics', 'reports'],
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
        writeFileSync(
            settings.paths.auditFile,
            `${JSON.stringify({
                actor: {
                    host: 'manager-host',
                    user: 'operator',
                },
                baseConfigHash: 'base-1',
                changedSiteIds: ['client'],
                id: 'evt-1',
                kind: 'apply-succeeded',
                message: 'Applied runtime config.',
                reloaded: true,
                rolledBack: false,
                runtimeConfigHash: 'runtime-1',
                stateHash: 'state-1',
                timestamp: '2026-05-02T10:05:00.000Z',
            })}\n`,
            'utf8',
        );

        const app = await buildApp({
            logger: false,
            settings,
        });

        try {
            const headers = {
                cookie: createSessionCookie(),
            };

            const dashboardResponse = await app.inject({
                headers,
                method: 'GET',
                url: '/',
            });
            expect(dashboardResponse.statusCode).toBe(200);
            expect(dashboardResponse.headers['content-security-policy']).toBe(
                "default-src 'none'; style-src 'unsafe-inline'; script-src 'unsafe-inline'; form-action 'self'; frame-ancestors 'none'; base-uri 'none'",
            );
            expect(dashboardResponse.body).toContain('Operations Dashboard');
            expect(dashboardResponse.body).toContain('/sites/client');
            expect(dashboardResponse.body).toContain('Pending edits');
            expect(dashboardResponse.body).toContain('action="/logout"');
            expect(dashboardResponse.body).toContain('color-scheme: light dark;');
            expect(dashboardResponse.body).toContain('@media (prefers-color-scheme: dark)');
            expect(dashboardResponse.body).toContain('--field-bg: rgba(255, 248, 240, 0.08);');
            expect(dashboardResponse.body).toContain('background: var(--field-bg);');
            expect(dashboardResponse.body).toContain('align-content: start;');
            expect(dashboardResponse.body).toContain('align-items: start;');
            expect(dashboardResponse.body).toContain('data-local-time="true"');
            expect(dashboardResponse.body).toContain('datetime="2026-05-02T10:00:00.000Z"');
            expect(dashboardResponse.body).toContain('2026-05-02 10:00 UTC');
            expect(dashboardResponse.body).toContain(
                "Intl.DateTimeFormat(undefined, { dateStyle: 'medium', timeStyle: 'short' })",
            );

            const siteResponse = await app.inject({
                headers,
                method: 'GET',
                url: '/sites/client',
            });
            expect(siteResponse.statusCode).toBe(200);
            expect(siteResponse.body).toContain('People with access');
            expect(siteResponse.body).toContain('data-editor-kind="new"');
            expect(siteResponse.body).not.toContain('data-editor-kind="new" open');
            expect(siteResponse.body).toContain('data-grant-email="admin@example.com"');
            expect(siteResponse.body).not.toContain('data-grant-email="admin@example.com" open');
            expect(siteResponse.body.indexOf('admin@example.com')).toBeLessThan(
                siteResponse.body.indexOf('reports@example.com'),
            );
            expect(siteResponse.body).toContain('reports@example.com');
            expect(siteResponse.body).toContain('analytics');
            expect(siteResponse.body).toContain('datetime="2026-05-02T10:00:00.000Z"');

            const diffResponse = await app.inject({
                headers,
                method: 'GET',
                url: '/diff',
            });
            expect(diffResponse.statusCode).toBe(200);
            expect(diffResponse.body).toContain('Managed access diff');
            expect(diffResponse.body).toContain('reports@example.com');
            expect(diffResponse.body).toContain('Check pending changes');
            expect(diffResponse.body).toContain('Publish changes');
            expect(diffResponse.body).toContain('datetime="2026-05-02T10:00:00.000Z"');

            const auditResponse = await app.inject({
                headers,
                method: 'GET',
                url: '/audit',
            });
            expect(auditResponse.statusCode).toBe(200);
            expect(auditResponse.body).toContain('Audit Log');
            expect(auditResponse.body).toContain('apply-succeeded');
            expect(auditResponse.body).toContain('datetime="2026-05-02T10:05:00.000Z"');

            const logoutResponse = await app.inject({
                headers: {
                    cookie: createSessionCookie(),
                    host: 'manager.example.test',
                    origin: 'http://manager.example.test',
                },
                method: 'POST',
                url: '/logout',
            });
            expect(logoutResponse.statusCode).toBe(303);
            expect(logoutResponse.headers.location).toBe('/login');
            expect(String(logoutResponse.headers['set-cookie'])).toContain(
                `${MANAGER_SESSION_COOKIE_NAME}=`,
            );
            expect(String(logoutResponse.headers['set-cookie'])).toContain('Max-Age=0');
        } finally {
            await app.close();
        }
    });
});
