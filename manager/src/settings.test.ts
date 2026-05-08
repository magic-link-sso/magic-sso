// SPDX-License-Identifier: GPL-3.0-or-later

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { afterEach, describe, expect, it } from 'vitest';
import {
    assertManagerAuditConfig,
    assertBootstrapAdminSiteIsNotManaged,
    assertReloadSecretIsNotPlaceholder,
    MANAGER_CONFIG_FILE_ENV_VAR_NAME,
    loadManagerRuntimeSettings,
    parseManagerRuntimeSettingsToml,
} from './settings.js';

function createManagerSettingsToml(overrides = ''): string {
    return `
	managedSiteIds = ["beta", "alpha"]

	[audit]
	integrityKey = "manager-audit-integrity-key-0123456789abcdefghij"
	maxArchivedFiles = 4
	maxFileBytes = 1048576

	[paths]
baseConfigFile = "../magic-sso.base.toml"
stateFile = "../manager-state.json"
runtimeConfigFile = "../magic-sso.runtime.toml"
lastGoodRuntimeConfigFile = "../magic-sso.runtime.last-good.toml"
auditFile = "../manager-audit.ndjson"
lockFile = "../manager.lock"

[reload]
url = "http://127.0.0.1:3000/internal/access-config/reload"
secret = "manager-reload-secret-0123456789abcdefghij"
timeoutMs = 5000

[service]
host = "127.0.0.1"
port = 4311

[service.auth]
bearerToken = "replace-me-with-a-dedicated-long-random-manager-api-token"
${overrides}
    `.trimStart();
}

const tempDirectories: string[] = [];

afterEach(() => {
    for (const directory of tempDirectories) {
        rmSync(directory, { force: true, recursive: true });
    }
    tempDirectories.length = 0;
});

describe('manager runtime settings', () => {
    it('parses and normalizes manager settings TOML', () => {
        const configFilePath = '/tmp/config/manager.toml';

        expect(
            parseManagerRuntimeSettingsToml(createManagerSettingsToml(), configFilePath),
        ).toEqual({
            audit: {
                integrityKey: 'manager-audit-integrity-key-0123456789abcdefghij',
                maxArchivedFiles: 4,
                maxFileBytes: 1048576,
            },
            configFilePath,
            managedSiteIds: ['alpha', 'beta'],
            paths: {
                auditFile: '/tmp/manager-audit.ndjson',
                baseConfigFile: '/tmp/magic-sso.base.toml',
                lastGoodRuntimeConfigFile: '/tmp/magic-sso.runtime.last-good.toml',
                lockFile: '/tmp/manager.lock',
                runtimeConfigFile: '/tmp/magic-sso.runtime.toml',
                stateFile: '/tmp/manager-state.json',
            },
            reload: {
                secret: 'manager-reload-secret-0123456789abcdefghij',
                timeoutMs: 5000,
                url: 'http://127.0.0.1:3000/internal/access-config/reload',
            },
            service: {
                auth: {
                    bearerToken: 'replace-me-with-a-dedicated-long-random-manager-api-token',
                },
                host: '127.0.0.1',
                port: 4311,
                trustProxy: false,
            },
        });
    });

    it('loads settings from MAGICSSO_MANAGER_CONFIG_FILE', () => {
        const tempDirectory = mkdtempSync(join(tmpdir(), 'magic-sso-manager-'));
        tempDirectories.push(tempDirectory);
        const configDirectory = join(tempDirectory, 'manager');
        const configFilePath = join(configDirectory, 'manager.toml');
        const baseConfigFile = join(tempDirectory, 'magic-sso.base.toml');
        const runtimeConfigFile = join(tempDirectory, 'magic-sso.runtime.toml');
        const lastGoodRuntimeConfigFile = join(tempDirectory, 'magic-sso.runtime.last-good.toml');
        const stateFile = join(tempDirectory, 'manager-state.json');
        const auditFile = join(tempDirectory, 'manager-audit.ndjson');
        const lockFile = join(tempDirectory, 'manager.lock');

        mkdirSync(configDirectory, { recursive: true });
        writeFileSync(
            configFilePath,
            createManagerSettingsToml().replace('timeoutMs = 5000', 'timeoutMs = 9000'),
            'utf8',
        );

        const settings = loadManagerRuntimeSettings({
            env: {
                [MANAGER_CONFIG_FILE_ENV_VAR_NAME]: configFilePath,
            },
        });

        expect(settings.paths.baseConfigFile).toBe(baseConfigFile);
        expect(settings.paths.runtimeConfigFile).toBe(runtimeConfigFile);
        expect(settings.paths.lastGoodRuntimeConfigFile).toBe(lastGoodRuntimeConfigFile);
        expect(settings.paths.stateFile).toBe(stateFile);
        expect(settings.paths.auditFile).toBe(auditFile);
        expect(settings.paths.lockFile).toBe(lockFile);
        expect(settings.reload?.timeoutMs).toBe(9000);
        expect(settings.service).toEqual({
            auth: {
                bearerToken: 'replace-me-with-a-dedicated-long-random-manager-api-token',
            },
            host: '127.0.0.1',
            port: 4311,
            trustProxy: false,
        });
    });

    it('rejects missing manager config env var', () => {
        expect(() => loadManagerRuntimeSettings({ env: {} })).toThrowError(
            `${MANAGER_CONFIG_FILE_ENV_VAR_NAME} must point to a manager settings TOML file.`,
        );
    });

    it('rejects duplicate managed site ids after normalization', () => {
        expect(() =>
            parseManagerRuntimeSettingsToml(
                createManagerSettingsToml().replace(
                    'managedSiteIds = ["beta", "alpha"]',
                    'managedSiteIds = ["alpha", " alpha "]',
                ),
                '/tmp/config/manager.toml',
            ),
        ).toThrowError('Managed site IDs must be unique: alpha');
    });

    it('allows CLI-only configs with no service settings', () => {
        const configFilePath = '/tmp/config/manager.toml';
        const cliOnlyToml = `
        managedSiteIds = ["alpha"]

        [audit]
        integrityKey = "manager-audit-integrity-key-0123456789abcdefghij"

        [paths]
baseConfigFile = "../magic-sso.base.toml"
stateFile = "../manager-state.json"
runtimeConfigFile = "../magic-sso.runtime.toml"
lastGoodRuntimeConfigFile = "../magic-sso.runtime.last-good.toml"
auditFile = "../manager-audit.ndjson"
lockFile = "../manager.lock"
        `.trimStart();

        expect(
            parseManagerRuntimeSettingsToml(cliOnlyToml, configFilePath).service,
        ).toBeUndefined();
    });

    it('parses Gate-backed service auth settings', () => {
        const configFilePath = '/tmp/config/manager.toml';

        expect(
            parseManagerRuntimeSettingsToml(
                createManagerSettingsToml().replace(
                    '[service.auth]\nbearerToken = "replace-me-with-a-dedicated-long-random-manager-api-token"',
                    '[service.auth]\nmode = "gate"\nrequiredSiteId = "manager-admin"\nrequiredScope = "*"',
                ),
                configFilePath,
            ).service,
        ).toEqual({
            auth: {
                mode: 'gate',
                requiredScope: '*',
                requiredSiteId: 'manager-admin',
            },
            host: '127.0.0.1',
            port: 4311,
            trustProxy: false,
        });
    });

    it('rejects placeholder reload secrets during config parsing', () => {
        expect(() =>
            parseManagerRuntimeSettingsToml(
                createManagerSettingsToml().replace(
                    'manager-reload-secret-0123456789abcdefghij',
                    'replace-me-with-a-dedicated-long-random-reload-secret',
                ),
                '/tmp/config/manager.toml',
            ),
        ).toThrowError(
            'reload.secret must be replaced with a dedicated random secret before starting the manager.',
        );
    });

    it('rejects Gate bootstrap admin sites in managedSiteIds during config parsing', () => {
        expect(() =>
            parseManagerRuntimeSettingsToml(
                createManagerSettingsToml()
                    .replace(
                        'managedSiteIds = ["beta", "alpha"]',
                        'managedSiteIds = ["client", "manager-admin"]',
                    )
                    .replace(
                        '[service.auth]\nbearerToken = "replace-me-with-a-dedicated-long-random-manager-api-token"',
                        '[service.auth]\nmode = "gate"\nrequiredSiteId = "manager-admin"\nrequiredScope = "*"',
                    ),
                '/tmp/config/manager.toml',
            ),
        ).toThrowError(
            'Managed site IDs cannot include the Gate bootstrap admin site (manager-admin). Keep it operator-managed in the base config to avoid lockout.',
        );
    });

    it('rejects programmatic Gate settings that manage the bootstrap admin site', () => {
        expect(() =>
            assertBootstrapAdminSiteIsNotManaged({
                configFilePath: '/tmp/config/manager.toml',
                managedSiteIds: ['client', 'manager-admin'],
                audit: {
                    integrityKey: 'manager-audit-integrity-key-0123456789abcdefghij',
                    maxArchivedFiles: 4,
                    maxFileBytes: 1048576,
                },
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
                    trustProxy: false,
                },
            }),
        ).toThrowError(
            'Managed site IDs cannot include the Gate bootstrap admin site (manager-admin). Keep it operator-managed in the base config to avoid lockout.',
        );
    });

    it('rejects programmatic settings that keep the placeholder reload secret', () => {
        expect(() =>
            assertReloadSecretIsNotPlaceholder({
                configFilePath: '/tmp/config/manager.toml',
                managedSiteIds: ['client'],
                audit: {
                    integrityKey: 'manager-audit-integrity-key-0123456789abcdefghij',
                    maxArchivedFiles: 4,
                    maxFileBytes: 1048576,
                },
                paths: {
                    auditFile: '/tmp/manager-audit.ndjson',
                    baseConfigFile: '/tmp/magic-sso.base.toml',
                    lastGoodRuntimeConfigFile: '/tmp/magic-sso.runtime.last-good.toml',
                    lockFile: '/tmp/manager.lock',
                    runtimeConfigFile: '/tmp/magic-sso.runtime.toml',
                    stateFile: '/tmp/manager-state.json',
                },
                reload: {
                    secret: 'replace-me-with-a-dedicated-long-random-reload-secret',
                    timeoutMs: 5000,
                    url: 'http://127.0.0.1:3000/internal/access-config/reload',
                },
                service: {
                    auth: {
                        bearerToken: 'replace-me-with-a-dedicated-long-random-manager-api-token',
                    },
                    host: '127.0.0.1',
                    port: 4311,
                    trustProxy: false,
                },
            }),
        ).toThrowError(
            'reload.secret must be replaced with a dedicated random secret before starting the manager.',
        );
    });

    it('rejects placeholder audit integrity keys during config parsing', () => {
        expect(() =>
            parseManagerRuntimeSettingsToml(
                createManagerSettingsToml().replace(
                    'manager-audit-integrity-key-0123456789abcdefghij',
                    'replace-me-with-a-dedicated-long-random-audit-integrity-key',
                ),
                '/tmp/config/manager.toml',
            ),
        ).toThrowError(
            'audit.integrityKey must be replaced with a dedicated random secret before starting the manager.',
        );
    });

    it('rejects programmatic settings that keep the placeholder audit integrity key', () => {
        expect(() =>
            assertManagerAuditConfig({
                configFilePath: '/tmp/config/manager.toml',
                managedSiteIds: ['client'],
                audit: {
                    integrityKey: 'replace-me-with-a-dedicated-long-random-audit-integrity-key',
                    maxArchivedFiles: 4,
                    maxFileBytes: 1048576,
                },
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
                        bearerToken: 'replace-me-with-a-dedicated-long-random-manager-api-token',
                    },
                    host: '127.0.0.1',
                    port: 4311,
                    trustProxy: false,
                },
            }),
        ).toThrowError(
            'audit.integrityKey must be replaced with a dedicated random secret before starting the manager.',
        );
    });
});
