// SPDX-License-Identifier: GPL-3.0-or-later

import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { afterEach, describe, expect, it } from 'vitest';
import { applyManagerState } from './apply.js';
import { buildRuntimePlan } from './runtime.js';
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

function createSettings(
    tempDirectory: string,
    options: {
        reload?: ManagerRuntimeSettings['reload'] | undefined;
    } = {},
): ManagerRuntimeSettings {
    return {
        audit: {
            integrityKey: 'manager-audit-integrity-key-0123456789abcdefghij',
            maxArchivedFiles: 4,
            maxFileBytes: 1024 * 1024,
        },
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
        reload: options.reload,
    };
}

function createManagedState(
    grants: ManagerState['managedSites']['client']['grants'],
): ManagerState {
    return {
        version: MANAGER_STATE_VERSION,
        managedSites: {
            client: {
                grants,
                scopeCatalog: ['analytics', 'reports'],
            },
        },
        metadata: {},
    };
}

function createTempDirectory(prefix: string): string {
    const tempDirectory = mkdtempSync(join(tmpdir(), prefix));
    tempDirectories.push(tempDirectory);
    return tempDirectory;
}

afterEach(() => {
    for (const directory of tempDirectories) {
        rmSync(directory, { force: true, recursive: true });
    }
    tempDirectories.length = 0;
});

describe('manager apply', () => {
    it('writes runtime, state metadata, last-known-good, and audit files', async () => {
        const tempDirectory = createTempDirectory('magic-sso-manager-apply-');
        const settings = createSettings(tempDirectory);
        writeFileSync(settings.paths.baseConfigFile, createBaseConfigToml(), 'utf8');

        const result = await applyManagerState(
            createManagedState([
                {
                    email: 'full@example.com',
                    scopes: ['*'],
                },
                {
                    email: 'reports@example.com',
                    scopes: ['analytics', 'reports'],
                },
            ]),
            settings,
            {
                actor: {
                    host: 'manager-host',
                    user: 'operator',
                },
                now: new Date('2026-05-02T10:05:00.000Z'),
            },
        );

        expect(result.auditPersisted).toBe(true);
        expect(result.reloadResult).toBeUndefined();
        expect(readFileSync(settings.paths.runtimeConfigFile, 'utf8')).toBe(
            result.runtimePlan.runtimeToml,
        );
        expect(readFileSync(settings.paths.lastGoodRuntimeConfigFile, 'utf8')).toBe(
            result.runtimePlan.runtimeToml,
        );

        const savedState = JSON.parse(
            readFileSync(settings.paths.stateFile, 'utf8'),
        ) as ManagerState;
        expect(savedState.metadata).toMatchObject({
            lastAppliedAt: '2026-05-02T10:05:00.000Z',
            lastAppliedBaseConfigHash: result.runtimePlan.baseConfigHash,
            lastAppliedRuntimeConfigHash: result.runtimePlan.runtimeConfigHash,
            lastAppliedStateHash: result.updatedState.metadata.lastAppliedStateHash,
        });

        const auditEvents = readFileSync(settings.paths.auditFile, 'utf8')
            .trim()
            .split('\n')
            .map((line) => JSON.parse(line) as Record<string, unknown>);
        expect(auditEvents).toHaveLength(1);
        expect(auditEvents[0]).toMatchObject({
            actor: {
                host: 'manager-host',
                user: 'operator',
            },
            kind: 'apply-succeeded',
            reloaded: false,
            rolledBack: false,
        });
    });

    it('replaces the runtime file before calling the reload endpoint', async () => {
        const tempDirectory = createTempDirectory('magic-sso-manager-reload-');
        let observedRuntimeContents = '';
        let observedReloadSecret = '';
        let observedReloadContentType: string | null = 'unexpected';

        const settings = createSettings(tempDirectory, {
            reload: {
                secret: 'manager-reload-secret-0123456789abcdefghij',
                timeoutMs: 5_000,
                url: 'http://127.0.0.1:3000/internal/access-config/reload',
            },
        });
        writeFileSync(settings.paths.baseConfigFile, createBaseConfigToml(), 'utf8');

        const fetchImplementation: typeof fetch = async (input, init) => {
            expect(input).toBe(settings.reload?.url);
            observedRuntimeContents = readFileSync(
                join(tempDirectory, 'magic-sso.runtime.toml'),
                'utf8',
            );
            const headers = new Headers(init?.headers);
            observedReloadSecret = String(headers.get('x-magic-sso-reload-secret'));
            observedReloadContentType = headers.get('content-type');
            return new Response(JSON.stringify({ changedSiteIds: ['client'], reloaded: true }), {
                headers: {
                    'content-type': 'application/json',
                },
                status: 200,
            });
        };

        const result = await applyManagerState(
            createManagedState([
                {
                    email: 'full@example.com',
                    scopes: ['*'],
                },
            ]),
            settings,
            {
                fetchImplementation,
            },
        );

        expect(observedRuntimeContents).toBe(result.runtimePlan.runtimeToml);
        expect(observedReloadSecret).toBe(settings.reload?.secret);
        expect(observedReloadContentType).toBeNull();
        expect(result.reloadResult).toEqual({
            changedSiteIds: ['client'],
            reloaded: true,
        });
        expect(readFileSync(settings.paths.lastGoodRuntimeConfigFile, 'utf8')).toBe(
            result.runtimePlan.runtimeToml,
        );
    });

    it('restores the previous runtime file when reload fails', async () => {
        const tempDirectory = createTempDirectory('magic-sso-manager-rollback-');
        const settings = createSettings(tempDirectory, {
            reload: {
                secret: 'manager-reload-secret-0123456789abcdefghij',
                timeoutMs: 5_000,
                url: 'http://127.0.0.1:3000/internal/access-config/reload',
            },
        });
        writeFileSync(settings.paths.baseConfigFile, createBaseConfigToml(), 'utf8');

        const previousState = createManagedState([
            {
                email: 'legacy-admin@example.com',
                scopes: ['*'],
            },
        ]);
        const previousRuntimePlan = buildRuntimePlan(previousState, settings);
        writeFileSync(settings.paths.runtimeConfigFile, previousRuntimePlan.runtimeToml, 'utf8');
        writeFileSync(
            settings.paths.lastGoodRuntimeConfigFile,
            previousRuntimePlan.runtimeToml,
            'utf8',
        );

        const fetchImplementation: typeof fetch = async () =>
            new Response(JSON.stringify({ message: 'Reload only supports site access changes.' }), {
                headers: {
                    'content-type': 'application/json',
                },
                status: 409,
            });

        await expect(
            applyManagerState(
                createManagedState([
                    {
                        email: 'full@example.com',
                        scopes: ['*'],
                    },
                ]),
                settings,
                {
                    fetchImplementation,
                },
            ),
        ).rejects.toThrow(/Server reload failed: Reload only supports site access changes./u);

        expect(readFileSync(settings.paths.runtimeConfigFile, 'utf8')).toBe(
            previousRuntimePlan.runtimeToml,
        );

        const auditEvents = readFileSync(settings.paths.auditFile, 'utf8')
            .trim()
            .split('\n')
            .map((line) => JSON.parse(line) as Record<string, unknown>);
        expect(auditEvents).toHaveLength(1);
        expect(auditEvents[0]).toMatchObject({
            kind: 'apply-failed',
            rolledBack: true,
        });
    });

    it('blocks apply when the base config drifted since the last successful apply', async () => {
        const tempDirectory = createTempDirectory('magic-sso-manager-base-drift-');
        const settings = createSettings(tempDirectory);
        writeFileSync(settings.paths.baseConfigFile, createBaseConfigToml(), 'utf8');

        const initialState = createManagedState([
            {
                email: 'full@example.com',
                scopes: ['*'],
            },
        ]);
        const initialRuntimePlan = buildRuntimePlan(initialState, settings);
        writeFileSync(settings.paths.runtimeConfigFile, initialRuntimePlan.runtimeToml, 'utf8');

        writeFileSync(
            settings.paths.baseConfigFile,
            `${createBaseConfigToml()}\n# operator edited the base file\n`,
            'utf8',
        );

        await expect(
            applyManagerState(
                {
                    ...initialState,
                    metadata: {
                        lastAppliedAt: '2026-05-02T09:55:00.000Z',
                        lastAppliedBaseConfigHash: initialRuntimePlan.baseConfigHash,
                        lastAppliedRuntimeConfigHash: initialRuntimePlan.runtimeConfigHash,
                        lastAppliedStateHash: 'state-hash',
                    },
                },
                settings,
            ),
        ).rejects.toThrow(
            /Base config drift detected\. Reconcile magic-sso\.base\.toml before running apply again\./u,
        );
    });

    it('refuses to run when another apply lock is already present', async () => {
        const tempDirectory = createTempDirectory('magic-sso-manager-lock-');
        const settings = createSettings(tempDirectory);
        writeFileSync(settings.paths.baseConfigFile, createBaseConfigToml(), 'utf8');
        writeFileSync(settings.paths.lockFile, 'already locked\n', 'utf8');

        await expect(
            applyManagerState(
                createManagedState([
                    {
                        email: 'full@example.com',
                        scopes: ['*'],
                    },
                ]),
                settings,
            ),
        ).rejects.toThrow(/Another manager apply is already in progress/u);
    });

    it('recovers a stale apply lock when the recorded pid is no longer alive', async () => {
        const tempDirectory = createTempDirectory('magic-sso-manager-stale-lock-');
        const settings = createSettings(tempDirectory);
        writeFileSync(settings.paths.baseConfigFile, createBaseConfigToml(), 'utf8');
        writeFileSync(
            settings.paths.lockFile,
            `${JSON.stringify({ pid: 999_999, startedAt: '2026-05-02T10:00:00.000Z' })}\n`,
            'utf8',
        );

        const result = await applyManagerState(
            createManagedState([
                {
                    email: 'full@example.com',
                    scopes: ['*'],
                },
            ]),
            settings,
        );

        expect(result.auditPersisted).toBe(true);
        expect(readFileSync(settings.paths.runtimeConfigFile, 'utf8')).toBe(
            result.runtimePlan.runtimeToml,
        );
    });
});
