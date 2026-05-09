// SPDX-License-Identifier: GPL-3.0-or-later

import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { describe, expect, it, afterEach } from 'vitest';
import { buildRuntimePlan, detectConfigDrift, summarizeManagedConfigDiff } from './runtime.js';
import { type ManagerRuntimeSettings } from './settings.js';
import { MANAGER_STATE_VERSION, type ManagerState } from './state.js';

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

function createSettings(tempDirectory: string): ManagerRuntimeSettings {
    return {
        configFilePath: join(tempDirectory, 'manager', 'manager.toml'),
        managedSiteIds: ['client'],
        paths: {
            auditFile: join(tempDirectory, 'manager-audit.ndjson'),
            baseConfigFile: join(tempDirectory, 'magic-sso.base.toml'),
            lastGoodRuntimeConfigFile: join(tempDirectory, 'magic-sso.runtime.last-good.toml'),
            lockFile: join(tempDirectory, 'manager.lock'),
            runtimeConfigFile: join(tempDirectory, 'magic-sso.runtime.toml'),
            stateFile: join(tempDirectory, 'manager-state.json'),
        },
    };
}

afterEach(() => {
    for (const directory of tempDirectories) {
        rmSync(directory, { force: true, recursive: true });
    }
    tempDirectories.length = 0;
});

describe('runtime planning', () => {
    it('renders a deterministic runtime TOML and preserves unmanaged site behavior', () => {
        const tempDirectory = mkdtempSync(join(tmpdir(), 'magic-sso-manager-runtime-'));
        tempDirectories.push(tempDirectory);
        const settings = createSettings(tempDirectory);
        writeFileSync(settings.paths.baseConfigFile, createBaseConfigToml(), 'utf8');

        const runtimePlan = buildRuntimePlan(
            {
                version: MANAGER_STATE_VERSION,
                managedSites: {
                    client: {
                        grants: [
                            {
                                email: 'full@example.com',
                                scopes: ['*'],
                            },
                            {
                                email: 'reports@example.com',
                                scopes: ['reports', 'analytics'],
                            },
                        ],
                        scopeCatalog: ['reports', 'analytics'],
                    },
                },
                metadata: {},
            },
            settings,
        );

        expect(runtimePlan.runtimeConfig.sites.map((site) => site.id)).toEqual(['client', 'docs']);
        expect(runtimePlan.runtimeConfig.sites[0]).toMatchObject({
            id: 'client',
            allowedEmails: ['full@example.com'],
            accessRules: [
                {
                    email: 'reports@example.com',
                    scopes: ['analytics', 'reports'],
                },
            ],
        });
        expect(runtimePlan.runtimeConfig.sites[1]).toMatchObject({
            id: 'docs',
            allowedEmails: ['docs@example.com'],
        });
        expect(runtimePlan.validatedRuntimeConfig.sites.map((site) => site.id)).toEqual([
            'client',
            'docs',
        ]);
    });

    it('summarizes semantic access diffs instead of a text patch', () => {
        const diffSummary = summarizeManagedConfigDiff(
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
                        accessRules: [
                            {
                                email: 'reports@example.com',
                                scopes: ['reports'],
                            },
                        ],
                        allowedEmails: ['legacy-admin@example.com'],
                        allowedRedirectUris: ['http://client.example.com/verify-email'],
                        id: 'client',
                        origins: ['http://client.example.com'],
                    },
                ],
            },
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
                        accessRules: [
                            {
                                email: 'reports@example.com',
                                scopes: ['reports', 'analytics'],
                            },
                        ],
                        allowedEmails: ['full@example.com'],
                        allowedRedirectUris: ['http://client.example.com/verify-email'],
                        id: 'client',
                        origins: ['http://client.example.com'],
                    },
                ],
            },
            ['client'],
        );

        expect(diffSummary).toEqual({
            changedSites: [
                {
                    addedFullAccessEmails: ['full@example.com'],
                    addedScopedGrants: [
                        {
                            email: 'reports@example.com',
                            scopes: ['analytics', 'reports'],
                        },
                    ],
                    removedFullAccessEmails: ['legacy-admin@example.com'],
                    removedScopedGrants: [
                        {
                            email: 'reports@example.com',
                            scopes: ['reports'],
                        },
                    ],
                    siteId: 'client',
                },
            ],
            hasChanges: true,
        });
    });

    it('detects base and runtime drift from hashes', () => {
        const tempDirectory = mkdtempSync(join(tmpdir(), 'magic-sso-manager-drift-'));
        tempDirectories.push(tempDirectory);
        const settings = createSettings(tempDirectory);
        writeFileSync(settings.paths.baseConfigFile, createBaseConfigToml(), 'utf8');

        const runtimePlan = buildRuntimePlan(
            {
                version: MANAGER_STATE_VERSION,
                managedSites: {
                    client: {
                        grants: [
                            {
                                email: 'full@example.com',
                                scopes: ['*'],
                            },
                        ],
                        scopeCatalog: ['reports'],
                    },
                },
                metadata: {},
            },
            settings,
        );
        writeFileSync(settings.paths.runtimeConfigFile, runtimePlan.runtimeToml, 'utf8');

        const noDriftStatus = detectConfigDrift(
            settings,
            runtimePlan.baseConfigHash,
            runtimePlan.runtimeConfigHash,
        );
        expect(noDriftStatus.baseConfigDrifted).toBe(false);
        expect(noDriftStatus.runtimeConfigDrifted).toBe(false);

        writeFileSync(
            settings.paths.baseConfigFile,
            `${createBaseConfigToml()}\n# operator changed the base file\n`,
            'utf8',
        );
        writeFileSync(
            settings.paths.runtimeConfigFile,
            `${runtimePlan.runtimeToml}\n# operator changed the runtime file\n`,
            'utf8',
        );

        const driftStatus = detectConfigDrift(
            settings,
            runtimePlan.baseConfigHash,
            runtimePlan.runtimeConfigHash,
        );
        expect(driftStatus.baseConfigDrifted).toBe(true);
        expect(driftStatus.runtimeConfigDrifted).toBe(true);
        expect(driftStatus.runtimeConfigExists).toBe(true);
    });

    it('treats a missing runtime file as drift', () => {
        const tempDirectory = mkdtempSync(join(tmpdir(), 'magic-sso-manager-runtime-missing-'));
        tempDirectories.push(tempDirectory);
        const settings = createSettings(tempDirectory);
        writeFileSync(settings.paths.baseConfigFile, createBaseConfigToml(), 'utf8');

        const runtimePlan = buildRuntimePlan(
            {
                version: MANAGER_STATE_VERSION,
                managedSites: {
                    client: {
                        grants: [
                            {
                                email: 'full@example.com',
                                scopes: ['*'],
                            },
                        ],
                        scopeCatalog: [],
                    },
                },
                metadata: {},
            },
            settings,
        );

        const driftStatus = detectConfigDrift(
            settings,
            runtimePlan.baseConfigHash,
            runtimePlan.runtimeConfigHash,
        );

        expect(driftStatus.runtimeConfigExists).toBe(false);
        expect(driftStatus.runtimeConfigDrifted).toBe(true);
        expect(driftStatus.currentRuntimeConfigHash).toBeUndefined();
    });

    it('fails validation when managed state would remove every access rule from a site', () => {
        const tempDirectory = mkdtempSync(join(tmpdir(), 'magic-sso-manager-invalid-runtime-'));
        tempDirectories.push(tempDirectory);
        const settings = createSettings(tempDirectory);
        writeFileSync(settings.paths.baseConfigFile, createBaseConfigToml(), 'utf8');

        expect(() =>
            buildRuntimePlan(
                {
                    version: MANAGER_STATE_VERSION,
                    managedSites: {
                        client: {
                            grants: [],
                            scopeCatalog: [],
                        },
                    },
                    metadata: {},
                } satisfies ManagerState,
                settings,
            ),
        ).toThrowError(/Each site must define allowedEmails, accessRules, or both./u);
    });
});
