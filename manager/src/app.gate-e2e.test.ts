// SPDX-License-Identifier: GPL-3.0-or-later

import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { IncomingMessage, ServerResponse } from 'node:http';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { SignJWT } from 'jose';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createApp as buildGateApp } from '../../gate/src/app.js';
import { buildApp } from './app.js';
import { MANAGER_STATE_VERSION } from './state.js';
import { type ManagerRuntimeSettings } from './settings.js';

const tempDirectories: string[] = [];
const testJwtSecret = 'test-jwt-secret-for-magic-gate-123456';
const testPreviewSecret = 'test-preview-secret-for-magic-gate-123';
const managerOrigin = 'http://manager.example.com';
const ssoOrigin = 'http://sso.example.com';

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
allowedEmails = ["bootstrap-client@example.com"]

[[sites]]
id = "manager-admin"
origins = ["${managerOrigin}"]
allowedRedirectUris = ["${managerOrigin}/_magicgate/verify-email", "${managerOrigin}/*"]
allowedEmails = ["manager@example.com"]
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

async function createAccessToken(): Promise<string> {
    const secret = new TextEncoder().encode(testJwtSecret);
    return await new SignJWT({
        email: 'manager@example.com',
        jti: 'manager-gate-session-jti',
        scope: '*',
        siteId: 'manager-admin',
    })
        .setProtectedHeader({ alg: 'HS256' })
        .setAudience(managerOrigin)
        .setIssuer(ssoOrigin)
        .sign(secret);
}

function createManagerProxyStub(managerApp: Awaited<ReturnType<typeof buildApp>>) {
    return {
        close(): void {
            // No-op for tests.
        },
        on(): void {
            // No-op for tests.
        },
        web(
            req: IncomingMessage,
            res: ServerResponse<IncomingMessage>,
            proxyOptions: {
                headers: Record<string, string>;
            },
        ): void {
            void managerApp
                .inject({
                    headers: {
                        ...Object.fromEntries(
                            Object.entries(req.headers)
                                .filter((entry): entry is [string, string | string[]] => {
                                    return typeof entry[1] !== 'undefined';
                                })
                                .map(([name, value]) => [
                                    name,
                                    Array.isArray(value) ? value.join(', ') : value,
                                ]),
                        ),
                        ...proxyOptions.headers,
                    },
                    method: req.method ?? 'GET',
                    url: req.url ?? '/',
                })
                .then((injectedResponse) => {
                    res.writeHead(injectedResponse.statusCode, injectedResponse.headers);
                    res.end(injectedResponse.body);
                })
                .catch((error: unknown) => {
                    res.writeHead(500, {
                        'content-type': 'application/json; charset=utf-8',
                    });
                    res.end(
                        JSON.stringify({
                            message: error instanceof Error ? error.message : String(error),
                        }),
                    );
                });
        },
        ws(): void {
            // Websocket coverage is not part of this manager auth flow.
        },
    };
}

afterEach(() => {
    vi.restoreAllMocks();
    for (const directory of tempDirectories) {
        rmSync(directory, { force: true, recursive: true });
    }
    tempDirectories.length = 0;
});

describe('manager service Gate end-to-end auth', () => {
    it('accepts a Gate-issued manager-admin session through the real proxy flow', async () => {
        const tempDirectory = createTempDirectory('magic-sso-manager-gate-e2e-');
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

        const managerApp = await buildApp({
            logger: false,
            settings,
        });

        vi.spyOn(globalThis, 'fetch').mockImplementation(async (input, init) => {
            const url = typeof input === 'string' ? input : input.toString();

            if (url.startsWith(`${ssoOrigin}/verify-email?`)) {
                return new Response(JSON.stringify({ email: 'manager@example.com' }), {
                    headers: {
                        'content-type': 'application/json',
                    },
                    status: 200,
                });
            }

            if (url === `${ssoOrigin}/verify-email` && init?.method === 'POST') {
                return new Response(
                    JSON.stringify({
                        accessToken: await createAccessToken(),
                    }),
                    {
                        headers: {
                            'content-type': 'application/json',
                        },
                        status: 200,
                    },
                );
            }

            if (url === `${ssoOrigin}/session-revocations/check` && init?.method === 'POST') {
                return new Response(JSON.stringify({ revoked: false }), {
                    headers: {
                        'content-type': 'application/json',
                    },
                    status: 200,
                });
            }

            throw new Error(`Unexpected fetch: ${url}`);
        });

        const gateApp = await buildGateApp({
            config: {
                directUse: false,
                jwtSecret: testJwtSecret,
                previewSecret: testPreviewSecret,
                publicOrigin: managerOrigin,
                requestTimeoutMs: 5_000,
                serverUrl: ssoOrigin,
                trustProxy: false,
                upstreamUrl: 'http://manager-upstream.internal',
            },
            logger: false,
            proxyFactory: () => createManagerProxyStub(managerApp),
        });

        try {
            const pageResponse = await gateApp.inject({
                method: 'GET',
                url: '/_magicgate/verify-email?token=test-token&returnUrl=http://manager.example.com/',
            });
            const csrfCookie = pageResponse.cookies.find(
                (cookie) => cookie.name === 'magic-sso.verify-csrf',
            );
            const tokenCookie = pageResponse.cookies.find(
                (cookie) => cookie.name === 'magic-sso.verify-token',
            );
            const csrfTokenMatch = pageResponse.body.match(/name="csrfToken" value="([^"]+)"/u);

            expect(pageResponse.statusCode).toBe(200);
            expect(csrfCookie?.value).toBeTruthy();
            expect(tokenCookie?.value).toBeTruthy();
            expect(csrfTokenMatch?.[1]).toBeTruthy();

            const verifyResponse = await gateApp.inject({
                headers: {
                    'content-type': 'application/x-www-form-urlencoded',
                    cookie: `magic-sso.verify-csrf=${csrfCookie?.value ?? ''}; magic-sso.verify-token=${tokenCookie?.value ?? ''}`,
                    origin: managerOrigin,
                },
                method: 'POST',
                payload: `csrfToken=${encodeURIComponent(csrfTokenMatch?.[1] ?? '')}&returnUrl=${encodeURIComponent(`${managerOrigin}/`)}`,
                url: '/_magicgate/verify-email',
            });
            const authCookie = verifyResponse.cookies.find((cookie) => cookie.name === 'magic-sso');

            expect(verifyResponse.statusCode).toBe(302);
            expect(verifyResponse.headers.location).toBe(`${managerOrigin}/`);
            expect(authCookie?.value).toBeTruthy();

            const dashboardResponse = await gateApp.inject({
                headers: {
                    cookie: `magic-sso=${encodeURIComponent(authCookie?.value ?? '')}`,
                },
                method: 'GET',
                url: '/',
            });
            expect(dashboardResponse.statusCode).toBe(200);
            expect(dashboardResponse.body).toContain('Operations Dashboard');
            expect(dashboardResponse.body).toContain('client');

            const apiResponse = await gateApp.inject({
                headers: {
                    accept: 'application/json',
                    cookie: `magic-sso=${encodeURIComponent(authCookie?.value ?? '')}`,
                },
                method: 'GET',
                url: '/api/sites',
            });
            expect(apiResponse.statusCode).toBe(200);
            expect(apiResponse.json()).toMatchObject({
                sites: [
                    {
                        id: 'client',
                    },
                ],
            });
        } finally {
            await gateApp.close();
            await managerApp.close();
        }
    });
});
