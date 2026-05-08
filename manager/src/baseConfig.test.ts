// SPDX-License-Identifier: GPL-3.0-or-later

import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { afterEach, describe, expect, it } from 'vitest';
import { loadBaseConfig, selectManagedSites } from './baseConfig.js';
import { createEmptyManagerState, MANAGER_STATE_VERSION, type ManagerState } from './state.js';
import { type ManagerRuntimeSettings } from './settings.js';

const tempDirectories: string[] = [];

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
id = "manager-admin"
origins = ["http://manager.example.com"]
allowedRedirectUris = ["http://manager.example.com/verify-email"]
allowedEmails = ["admin@example.com"]

[[sites]]
id = "client"
origins = ["http://client.example.com"]
allowedRedirectUris = ["http://client.example.com/verify-email", "http://client.example.com/*"]
allowedEmails = ["legacy-admin@example.com"]

[[sites]]
id = "docs"
origins = ["http://docs.example.com"]
allowedRedirectUris = ["http://docs.example.com/verify-email"]
allowedEmails = ["docs@example.com"]
    `.trimStart();
}

function createSettings(baseConfigFile: string): ManagerRuntimeSettings {
    return {
        configFilePath: '/tmp/manager/manager.toml',
        managedSiteIds: ['client'],
        paths: {
            auditFile: '/tmp/manager-audit.ndjson',
            baseConfigFile,
            lastGoodRuntimeConfigFile: '/tmp/magic-sso.runtime.last-good.toml',
            lockFile: '/tmp/manager.lock',
            runtimeConfigFile: '/tmp/magic-sso.runtime.toml',
            stateFile: '/tmp/manager-state.json',
        },
    };
}

afterEach(() => {
    for (const directory of tempDirectories) {
        rmSync(directory, { force: true, recursive: true });
    }
    tempDirectories.length = 0;
});

describe('base config selection', () => {
    it('loads and validates the base TOML from manager settings', () => {
        const tempDirectory = mkdtempSync(join(tmpdir(), 'magic-sso-manager-base-'));
        tempDirectories.push(tempDirectory);
        const baseConfigFile = join(tempDirectory, 'magic-sso.base.toml');
        writeFileSync(baseConfigFile, createBaseConfigToml(), 'utf8');

        const baseConfig = loadBaseConfig(createSettings(baseConfigFile));

        expect(baseConfig.sites.map((site) => site.id)).toEqual([
            'manager-admin',
            'client',
            'docs',
        ]);
    });

    it('selects only configured managed sites and leaves unmanaged sites untouched', () => {
        const settings = createSettings('/tmp/magic-sso.base.toml');
        const selection = selectManagedSites(
            {
                auth: {
                    csrfSecret: 'csrf-secret-0123456789-012345678',
                    emailExpiration: '15m',
                    emailSecret: 'email-secret-0123456789-01234567',
                    jwtExpiration: '1h',
                    jwtSecret: 'jwt-secret-0123456789-0123456789',
                    previewSecret: 'preview-secret-0123456789-0123456',
                },
                email: {
                    from: 'owner@example.com',
                    signature: '',
                    smtp: {
                        host: 'smtp.example.com',
                        pass: 'smtp-password',
                        port: 587,
                        secure: false,
                        user: 'smtp-user',
                    },
                    smtpFallbacks: [],
                },
                hostedAuth: {},
                sites: [
                    {
                        accessRules: [],
                        allowedEmails: ['admin@example.com'],
                        allowedRedirectUris: ['http://manager.example.com/verify-email'],
                        id: 'manager-admin',
                        origins: ['http://manager.example.com'],
                    },
                    {
                        accessRules: [],
                        allowedEmails: ['legacy-admin@example.com'],
                        allowedRedirectUris: [
                            'http://client.example.com/verify-email',
                            'http://client.example.com/*',
                        ],
                        id: 'client',
                        origins: ['http://client.example.com'],
                    },
                    {
                        accessRules: [],
                        allowedEmails: ['docs@example.com'],
                        allowedRedirectUris: ['http://docs.example.com/verify-email'],
                        id: 'docs',
                        origins: ['http://docs.example.com'],
                    },
                ],
            },
            {
                version: MANAGER_STATE_VERSION,
                managedSites: {
                    client: {
                        grants: [
                            {
                                email: 'editor@example.com',
                                scopes: ['docs:write'],
                            },
                        ],
                        scopeCatalog: ['docs:write'],
                    },
                },
                metadata: {},
            },
            settings,
        );

        expect(selection.managedSites).toEqual([
            {
                siteConfig: {
                    accessRules: [],
                    allowedEmails: ['legacy-admin@example.com'],
                    allowedRedirectUris: [
                        'http://client.example.com/verify-email',
                        'http://client.example.com/*',
                    ],
                    id: 'client',
                    origins: ['http://client.example.com'],
                },
                siteState: {
                    grants: [
                        {
                            email: 'editor@example.com',
                            scopes: ['docs:write'],
                        },
                    ],
                    scopeCatalog: ['docs:write'],
                },
            },
        ]);
        expect(selection.unmanagedSites.map((site) => site.id)).toEqual(['manager-admin', 'docs']);
    });

    it('seeds empty state for managed sites that do not have persisted grants yet', () => {
        const settings = createSettings('/tmp/magic-sso.base.toml');

        const selection = selectManagedSites(
            {
                auth: {
                    csrfSecret: 'csrf-secret-0123456789-012345678',
                    emailExpiration: '15m',
                    emailSecret: 'email-secret-0123456789-01234567',
                    jwtExpiration: '1h',
                    jwtSecret: 'jwt-secret-0123456789-0123456789',
                    previewSecret: 'preview-secret-0123456789-0123456',
                },
                email: {
                    from: 'owner@example.com',
                    signature: '',
                    smtp: {
                        host: 'smtp.example.com',
                        pass: 'smtp-password',
                        port: 587,
                        secure: false,
                        user: 'smtp-user',
                    },
                    smtpFallbacks: [],
                },
                hostedAuth: {},
                sites: [
                    {
                        accessRules: [],
                        allowedEmails: ['legacy-admin@example.com'],
                        allowedRedirectUris: [
                            'http://client.example.com/verify-email',
                            'http://client.example.com/*',
                        ],
                        id: 'client',
                        origins: ['http://client.example.com'],
                    },
                ],
            },
            createEmptyManagerState(),
            settings,
        );

        expect(selection.managedSites[0]?.siteState).toEqual({
            grants: [],
            scopeCatalog: [],
        });
    });

    it('rejects managed site ids that are missing from the base config', () => {
        const settings = {
            ...createSettings('/tmp/magic-sso.base.toml'),
            managedSiteIds: ['missing-site'],
        } satisfies ManagerRuntimeSettings;

        expect(() =>
            selectManagedSites(
                {
                    auth: {
                        csrfSecret: 'csrf-secret-0123456789-012345678',
                        emailExpiration: '15m',
                        emailSecret: 'email-secret-0123456789-01234567',
                        jwtExpiration: '1h',
                        jwtSecret: 'jwt-secret-0123456789-0123456789',
                        previewSecret: 'preview-secret-0123456789-0123456',
                    },
                    email: {
                        from: 'owner@example.com',
                        signature: '',
                        smtp: {
                            host: 'smtp.example.com',
                            pass: 'smtp-password',
                            port: 587,
                            secure: false,
                            user: 'smtp-user',
                        },
                        smtpFallbacks: [],
                    },
                    hostedAuth: {},
                    sites: [
                        {
                            accessRules: [],
                            allowedEmails: ['legacy-admin@example.com'],
                            allowedRedirectUris: [
                                'http://client.example.com/verify-email',
                                'http://client.example.com/*',
                            ],
                            id: 'client',
                            origins: ['http://client.example.com'],
                        },
                    ],
                },
                createEmptyManagerState(),
                settings,
            ),
        ).toThrowError('Managed site missing-site is missing from /tmp/magic-sso.base.toml.');
    });

    it('rejects selecting the Gate bootstrap admin site as a managed site', () => {
        const settings = {
            ...createSettings('/tmp/magic-sso.base.toml'),
            managedSiteIds: ['client', 'manager-admin'],
            service: {
                auth: {
                    mode: 'gate',
                    requiredScope: '*',
                    requiredSiteId: 'manager-admin',
                },
                host: '127.0.0.1',
                port: 4311,
            },
        } satisfies ManagerRuntimeSettings;

        expect(() =>
            selectManagedSites(
                {
                    auth: {
                        csrfSecret: 'csrf-secret-0123456789-012345678',
                        emailExpiration: '15m',
                        emailSecret: 'email-secret-0123456789-01234567',
                        jwtExpiration: '1h',
                        jwtSecret: 'jwt-secret-0123456789-0123456789',
                        previewSecret: 'preview-secret-0123456789-0123456',
                    },
                    email: {
                        from: 'owner@example.com',
                        signature: '',
                        smtp: {
                            host: 'smtp.example.com',
                            pass: 'smtp-password',
                            port: 587,
                            secure: false,
                            user: 'smtp-user',
                        },
                        smtpFallbacks: [],
                    },
                    hostedAuth: {},
                    sites: [
                        {
                            accessRules: [],
                            allowedEmails: ['admin@example.com'],
                            allowedRedirectUris: ['http://manager.example.com/verify-email'],
                            id: 'manager-admin',
                            origins: ['http://manager.example.com'],
                        },
                        {
                            accessRules: [],
                            allowedEmails: ['legacy-admin@example.com'],
                            allowedRedirectUris: [
                                'http://client.example.com/verify-email',
                                'http://client.example.com/*',
                            ],
                            id: 'client',
                            origins: ['http://client.example.com'],
                        },
                    ],
                },
                createEmptyManagerState(['client', 'manager-admin']),
                settings,
            ),
        ).toThrowError(
            'Managed site IDs cannot include the Gate bootstrap admin site (manager-admin). Keep it operator-managed in the base config to avoid lockout.',
        );
    });

    it('rejects unmanaged site entries in persisted state', () => {
        const settings = createSettings('/tmp/magic-sso.base.toml');
        const invalidState = {
            version: MANAGER_STATE_VERSION,
            managedSites: {
                client: {
                    grants: [],
                    scopeCatalog: [],
                },
                docs: {
                    grants: [],
                    scopeCatalog: [],
                },
            },
            metadata: {},
        } satisfies ManagerState;

        expect(() =>
            selectManagedSites(
                {
                    auth: {
                        csrfSecret: 'csrf-secret-0123456789-012345678',
                        emailExpiration: '15m',
                        emailSecret: 'email-secret-0123456789-01234567',
                        jwtExpiration: '1h',
                        jwtSecret: 'jwt-secret-0123456789-0123456789',
                        previewSecret: 'preview-secret-0123456789-0123456',
                    },
                    email: {
                        from: 'owner@example.com',
                        signature: '',
                        smtp: {
                            host: 'smtp.example.com',
                            pass: 'smtp-password',
                            port: 587,
                            secure: false,
                            user: 'smtp-user',
                        },
                        smtpFallbacks: [],
                    },
                    hostedAuth: {},
                    sites: [
                        {
                            accessRules: [],
                            allowedEmails: ['legacy-admin@example.com'],
                            allowedRedirectUris: [
                                'http://client.example.com/verify-email',
                                'http://client.example.com/*',
                            ],
                            id: 'client',
                            origins: ['http://client.example.com'],
                        },
                        {
                            accessRules: [],
                            allowedEmails: ['docs@example.com'],
                            allowedRedirectUris: ['http://docs.example.com/verify-email'],
                            id: 'docs',
                            origins: ['http://docs.example.com'],
                        },
                    ],
                },
                invalidState,
                settings,
            ),
        ).toThrowError('Manager state contains an unmanaged site: docs');
    });
});
