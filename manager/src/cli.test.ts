// SPDX-License-Identifier: GPL-3.0-or-later

import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { afterEach, describe, expect, it } from 'vitest';
import { runCli } from './cli.js';
import { MANAGER_CONFIG_FILE_ENV_VAR_NAME } from './settings.js';

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

function createManagerSettingsToml(): string {
    return `
	managedSiteIds = ["client"]

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
    `.trimStart();
}

function createTempDirectory(prefix: string): string {
    const tempDirectory = mkdtempSync(join(tmpdir(), prefix));
    tempDirectories.push(tempDirectory);
    return tempDirectory;
}

function createWriter(): { output: string; writer: { write: (value: string) => void } } {
    let output = '';
    return {
        get output() {
            return output;
        },
        writer: {
            write: (value: string) => {
                output += value;
            },
        },
    };
}

function setupManagerFiles(): {
    configFilePath: string;
    env: NodeJS.ProcessEnv;
    tempDirectory: string;
} {
    const tempDirectory = createTempDirectory('magic-sso-manager-cli-');
    const configDirectory = join(tempDirectory, 'manager');
    const configFilePath = join(configDirectory, 'manager.toml');

    mkdirSync(configDirectory, { recursive: true });
    writeFileSync(join(tempDirectory, 'magic-sso.base.toml'), createBaseConfigToml(), 'utf8');
    writeFileSync(configFilePath, createManagerSettingsToml(), 'utf8');

    return {
        configFilePath,
        env: {
            [MANAGER_CONFIG_FILE_ENV_VAR_NAME]: configFilePath,
        },
        tempDirectory,
    };
}

afterEach(() => {
    for (const directory of tempDirectories) {
        rmSync(directory, { force: true, recursive: true });
    }
    tempDirectories.length = 0;
});

describe('manager cli', () => {
    it('keeps unsupported provisioning and global-edit commands unavailable', async () => {
        const setup = setupManagerFiles();
        const siteStdout = createWriter();
        const siteStderr = createWriter();

        const siteCreateExitCode = await runCli({
            argv: ['sites', 'create', 'new-site'],
            env: setup.env,
            stderr: siteStderr.writer,
            stdout: siteStdout.writer,
        });

        expect(siteCreateExitCode).toBe(1);
        expect(siteStderr.output).toContain(
            'Usage: manager sites list [--json] | manager sites show <siteId> [--json]',
        );

        const configStdout = createWriter();
        const configStderr = createWriter();
        const configSetExitCode = await runCli({
            argv: ['config', 'set', 'server.appUrl', 'http://manager.example.com'],
            env: setup.env,
            stderr: configStderr.writer,
            stdout: configStdout.writer,
        });

        expect(configSetExitCode).toBe(1);
        expect(configStderr.output).toContain('Unknown command: config');
    });

    it('lists managed sites as json', async () => {
        const setup = setupManagerFiles();
        const stdout = createWriter();
        const stderr = createWriter();

        const exitCode = await runCli({
            argv: ['sites', 'list', '--json'],
            env: setup.env,
            stderr: stderr.writer,
            stdout: stdout.writer,
        });

        expect(exitCode).toBe(0);
        expect(JSON.parse(stdout.output)).toEqual([
            {
                allowedRedirectUris: [
                    'http://client.example.com/verify-email',
                    'http://client.example.com/*',
                ],
                grantCount: 0,
                id: 'client',
                origins: ['http://client.example.com'],
                scopeCount: 0,
            },
        ]);
        expect(stderr.output).toBe('');
    });

    it('grants full access and persists normalized state', async () => {
        const setup = setupManagerFiles();
        const stdout = createWriter();
        const stderr = createWriter();

        const addScopeExitCode = await runCli({
            argv: ['scopes', 'add', 'client', 'reports'],
            env: setup.env,
            stderr: stderr.writer,
            stdout: stdout.writer,
        });
        expect(addScopeExitCode).toBe(0);

        const exitCode = await runCli({
            argv: ['access', 'grant', 'client', ' Admin@Example.com ', '--full-access'],
            env: setup.env,
            stderr: stderr.writer,
            stdout: stdout.writer,
        });

        expect(exitCode).toBe(0);
        expect(stdout.output).toContain('Audit persisted: yes');
        expect(stdout.output).toContain('Updated grant for  Admin@Example.com  on client.');
        const savedState = JSON.parse(
            readFileSync(join(setup.tempDirectory, 'manager-state.json'), 'utf8'),
        ) as {
            managedSites: {
                client: {
                    grants: Array<{ email: string; scopes: string[] }>;
                };
            };
        };
        expect(savedState.managedSites.client.grants).toEqual([
            {
                email: 'admin@example.com',
                scopes: ['*'],
            },
        ]);
        expect(readFileSync(join(setup.tempDirectory, 'manager-audit.ndjson'), 'utf8')).toContain(
            '"kind":"grant-saved"',
        );
        expect(stderr.output).toBe('');
    });

    it('revokes grants and records audit output after confirmation', async () => {
        const setup = setupManagerFiles();
        const stdout = createWriter();
        const stderr = createWriter();

        await runCli({
            argv: ['scopes', 'add', 'client', 'reports'],
            env: setup.env,
            stderr: stderr.writer,
            stdout: stdout.writer,
        });
        await runCli({
            argv: ['access', 'grant', 'client', 'admin@example.com', '--scope', 'reports'],
            env: setup.env,
            stderr: stderr.writer,
            stdout: stdout.writer,
        });

        const exitCode = await runCli({
            argv: ['access', 'revoke', 'client', 'admin@example.com'],
            confirm: async () => true,
            env: setup.env,
            isInteractive: true,
            stderr: stderr.writer,
            stdout: stdout.writer,
        });

        expect(exitCode).toBe(0);
        expect(stdout.output).toContain('Audit persisted: yes');
        expect(stdout.output).toContain('Revoked access for admin@example.com on client.');
        expect(
            JSON.parse(readFileSync(join(setup.tempDirectory, 'manager-state.json'), 'utf8')),
        ).toMatchObject({
            managedSites: {
                client: {
                    grants: [],
                },
            },
        });
        expect(readFileSync(join(setup.tempDirectory, 'manager-audit.ndjson'), 'utf8')).toContain(
            '"kind":"grant-revoked"',
        );
        expect(stderr.output).toBe('');
    });

    it('fails closed for revoke without --yes when stdin is not interactive', async () => {
        const setup = setupManagerFiles();
        const stdout = createWriter();
        const stderr = createWriter();

        await runCli({
            argv: ['access', 'grant', 'client', 'admin@example.com', '--full-access'],
            env: setup.env,
            stderr: stderr.writer,
            stdout: stdout.writer,
        });

        const exitCode = await runCli({
            argv: ['access', 'revoke', 'client', 'admin@example.com'],
            env: setup.env,
            isInteractive: false,
            stderr: stderr.writer,
            stdout: stdout.writer,
        });

        expect(exitCode).toBe(1);
        expect(stderr.output).toContain(
            'This command requires --yes when stdin is not interactive.',
        );
    });

    it('aborts revoke when confirmation is declined', async () => {
        const setup = setupManagerFiles();
        const stdout = createWriter();
        const stderr = createWriter();

        await runCli({
            argv: ['access', 'grant', 'client', 'admin@example.com', '--full-access'],
            env: setup.env,
            stderr: stderr.writer,
            stdout: stdout.writer,
        });

        const exitCode = await runCli({
            argv: ['access', 'revoke', 'client', 'admin@example.com'],
            confirm: async () => false,
            env: setup.env,
            isInteractive: true,
            stderr: stderr.writer,
            stdout: stdout.writer,
        });

        expect(exitCode).toBe(1);
        expect(stderr.output).toContain('Access revoke aborted.');
    });

    it('removes scopes when confirmation is accepted', async () => {
        const setup = setupManagerFiles();
        const stdout = createWriter();
        const stderr = createWriter();

        await runCli({
            argv: ['scopes', 'add', 'client', 'reports'],
            env: setup.env,
            stderr: stderr.writer,
            stdout: stdout.writer,
        });

        const exitCode = await runCli({
            argv: ['scopes', 'remove', 'client', 'reports'],
            confirm: async () => true,
            env: setup.env,
            isInteractive: true,
            stderr: stderr.writer,
            stdout: stdout.writer,
        });

        expect(exitCode).toBe(0);
        expect(stdout.output).toContain('Removed scope reports from client.');
        const savedState = JSON.parse(
            readFileSync(join(setup.tempDirectory, 'manager-state.json'), 'utf8'),
        ) as {
            managedSites: {
                client: {
                    scopeCatalog: string[];
                };
            };
        };
        expect(savedState.managedSites.client.scopeCatalog).toEqual([]);
        const auditEvents = readFileSync(join(setup.tempDirectory, 'manager-audit.ndjson'), 'utf8')
            .trim()
            .split('\n')
            .map(
                (line) =>
                    JSON.parse(line) as {
                        changedSiteIds: string[];
                        kind: string;
                    },
            );
        expect(auditEvents.map((event) => event.kind)).toEqual(['scope-added', 'scope-removed']);
        expect(auditEvents[1]).toMatchObject({
            changedSiteIds: ['client'],
        });
        expect(stdout.output).toContain('Audit persisted: yes');
        expect(stderr.output).toBe('');
    });

    it('returns a non-zero exit code when validation fails', async () => {
        const setup = setupManagerFiles();
        const stdout = createWriter();
        const stderr = createWriter();

        const exitCode = await runCli({
            argv: ['validate'],
            env: setup.env,
            stderr: stderr.writer,
            stdout: stdout.writer,
        });

        expect(exitCode).toBe(1);
        expect(stderr.output).toContain(
            'Each site must define allowedEmails, accessRules, or both.',
        );
    });

    it('applies with --yes and writes runtime plus audit files', async () => {
        const setup = setupManagerFiles();
        const stdout = createWriter();
        const stderr = createWriter();

        await runCli({
            argv: ['scopes', 'add', 'client', 'reports'],
            env: setup.env,
            stderr: stderr.writer,
            stdout: stdout.writer,
        });
        await runCli({
            argv: ['access', 'grant', 'client', 'admin@example.com', '--scope', 'reports'],
            env: setup.env,
            stderr: stderr.writer,
            stdout: stdout.writer,
        });

        const exitCode = await runCli({
            argv: ['apply', '--yes'],
            env: setup.env,
            now: new Date('2026-05-02T11:00:00.000Z'),
            stderr: stderr.writer,
            stdout: stdout.writer,
        });

        expect(exitCode).toBe(0);
        expect(readFileSync(join(setup.tempDirectory, 'magic-sso.runtime.toml'), 'utf8')).toContain(
            'reports',
        );
        expect(readFileSync(join(setup.tempDirectory, 'manager-audit.ndjson'), 'utf8')).toContain(
            'apply-succeeded',
        );
        expect(stderr.output).toBe('');
    });

    it('exports portable manager state snapshots as normalized json', async () => {
        const setup = setupManagerFiles();
        const stdout = createWriter();
        const stderr = createWriter();

        await runCli({
            argv: ['scopes', 'add', 'client', 'reports'],
            env: setup.env,
            stderr: stderr.writer,
            stdout: stdout.writer,
        });
        await runCli({
            argv: ['access', 'grant', 'client', 'Admin@Example.com', '--full-access'],
            env: setup.env,
            stderr: stderr.writer,
            stdout: stdout.writer,
        });

        const exportStdout = createWriter();
        const exportStderr = createWriter();

        const exitCode = await runCli({
            argv: ['export', '--json'],
            env: setup.env,
            stderr: exportStderr.writer,
            stdout: exportStdout.writer,
        });

        expect(exitCode).toBe(0);
        expect(JSON.parse(exportStdout.output)).toEqual({
            version: 1,
            managedSites: {
                client: {
                    grants: [
                        {
                            email: 'admin@example.com',
                            scopes: ['*'],
                        },
                    ],
                    scopeCatalog: ['reports'],
                },
            },
        });
        expect(exportStderr.output).toBe('');
    });

    it('imports portable manager state snapshots only after confirmation', async () => {
        const setup = setupManagerFiles();
        const stdout = createWriter();
        const stderr = createWriter();
        const snapshotPath = join(setup.tempDirectory, 'portable-state.json');
        writeFileSync(
            snapshotPath,
            JSON.stringify(
                {
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
                },
                null,
                2,
            ),
            'utf8',
        );

        const abortedExitCode = await runCli({
            argv: ['import', snapshotPath],
            confirm: async () => false,
            env: setup.env,
            isInteractive: true,
            stderr: stderr.writer,
            stdout: stdout.writer,
        });
        expect(abortedExitCode).toBe(1);
        expect(stderr.output).toContain('State import aborted.');

        const importedExitCode = await runCli({
            argv: ['import', snapshotPath, '--yes'],
            env: setup.env,
            isInteractive: false,
            stderr: stderr.writer,
            stdout: stdout.writer,
        });
        expect(importedExitCode).toBe(0);
        expect(
            JSON.parse(readFileSync(join(setup.tempDirectory, 'manager-state.json'), 'utf8')),
        ).toEqual({
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
        expect(readFileSync(join(setup.tempDirectory, 'manager-audit.ndjson'), 'utf8')).toContain(
            '"kind":"state-imported"',
        );
    });

    it('reports reconcile status and rejects invalid import payloads', async () => {
        const setup = setupManagerFiles();
        const stdout = createWriter();
        const stderr = createWriter();
        const invalidSnapshotPath = join(setup.tempDirectory, 'portable-state.invalid.json');
        writeFileSync(
            invalidSnapshotPath,
            JSON.stringify({
                version: 1,
                managedSites: {
                    docs: {
                        grants: [],
                        scopeCatalog: [],
                    },
                },
            }),
            'utf8',
        );

        const statusExitCode = await runCli({
            argv: ['reconcile', 'status', '--json'],
            env: setup.env,
            stderr: stderr.writer,
            stdout: stdout.writer,
        });
        expect(statusExitCode).toBe(0);
        expect(JSON.parse(stdout.output)).toMatchObject({
            base: {
                available: true,
                preview: {
                    source: 'base',
                },
            },
            runtime: {
                available: false,
                error: `Managed runtime config file is missing: ${join(setup.tempDirectory, 'magic-sso.runtime.toml')}`,
                source: 'runtime',
            },
        });

        const importExitCode = await runCli({
            argv: ['import', invalidSnapshotPath, '--yes'],
            env: setup.env,
            isInteractive: false,
            stderr: stderr.writer,
            stdout: stdout.writer,
        });
        expect(importExitCode).toBe(1);
        expect(stderr.output).toContain('Portable manager state contains an unmanaged site: docs');
    });

    it('reconciles manager state from runtime config and records audit output', async () => {
        const setup = setupManagerFiles();
        const stdout = createWriter();
        const stderr = createWriter();

        writeFileSync(
            join(setup.tempDirectory, 'magic-sso.runtime.toml'),
            `
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
allowedEmails = ["runtime-admin@example.com"]

[[sites.accessRules]]
email = "runtime-viewer@example.com"
scopes = ["reports"]
            `.trimStart(),
            'utf8',
        );

        const exitCode = await runCli({
            argv: ['reconcile', 'runtime', '--yes'],
            env: setup.env,
            isInteractive: false,
            stderr: stderr.writer,
            stdout: stdout.writer,
        });

        expect(exitCode).toBe(0);
        expect(
            JSON.parse(readFileSync(join(setup.tempDirectory, 'manager-state.json'), 'utf8')),
        ).toEqual({
            version: 1,
            managedSites: {
                client: {
                    grants: [
                        {
                            email: 'runtime-admin@example.com',
                            scopes: ['*'],
                        },
                        {
                            email: 'runtime-viewer@example.com',
                            scopes: ['reports'],
                        },
                    ],
                    scopeCatalog: ['reports'],
                },
            },
            metadata: {},
        });
        expect(stdout.output).toContain('Reconciled manager state from the runtime config.');
        expect(stdout.output).toContain('Audit persisted: yes');
        expect(readFileSync(join(setup.tempDirectory, 'manager-audit.ndjson'), 'utf8')).toContain(
            '"kind":"state-reconciled"',
        );
    });
});
