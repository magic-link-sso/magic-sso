// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Wojciech Polak

import { execFile } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { promisify } from 'node:util';
import { describe, expect, it } from 'vitest';
import {
    applyManagerState,
    loadManagerStateOrEmpty,
    persistManagerState,
    reloadManagerRuntime,
    updateSiteGrant,
} from '../manager/src/index.js';
import type { ManagerRuntimeSettings } from '../manager/src/settings.js';

const execute = promisify(execFile);
const reloadSecret = 'docker-reload-secret-0123456789abcdef';

async function docker(args: string[]): Promise<string> {
    const result = await execute('docker', args, { encoding: 'utf8', timeout: 120_000 });
    return result.stdout.trim();
}

async function waitForServer(origin: string): Promise<void> {
    for (let attempt = 0; attempt < 100; attempt += 1) {
        try {
            const response = await fetch(`${origin}/healthz`, {
                signal: AbortSignal.timeout(1000),
            });
            if (response.ok) {
                return;
            }
        } catch {
            /* Wait for the container's actual readiness. */
        }
        await delay(100);
    }
    throw new Error('Magic Link SSO Docker smoke server did not become ready.');
}

describe('managed runtime mount instructions', () => {
    it('mounts the runtime directory on the server in both production guides', async () => {
        for (const path of ['manager/README.md', 'docs/managed-mode.md']) {
            const contents = await readFile(path, 'utf8');
            expect(contents, path).toContain('/srv/magic-link-sso/managed:/app/runtime:ro');
            expect(contents, path).toContain(
                'MAGICSSO_CONFIG_FILE=/app/runtime/magic-sso.runtime.toml',
            );
        }
    });
});

describe.skipIf(process.env.MAGICSSO_DOCKER_SMOKE !== '1')('managed reload Docker smoke', () => {
    it('adopts an atomic runtime replacement through a read-only directory mount without restarting', async () => {
        const directory = await mkdtemp(join(tmpdir(), 'magic-sso-docker-reload-'));
        const name = `magic-sso-reload-${randomUUID()}`;
        const settings: ManagerRuntimeSettings = {
            configFilePath: join(directory, 'manager.toml'),
            audit: {
                integrityKey: 'docker-audit-key-0123456789abcdefghij',
                maxArchivedFiles: 1,
                maxFileBytes: 1_048_576,
            },
            managedSiteIds: ['client'],
            paths: {
                auditFile: join(directory, 'audit.ndjson'),
                baseConfigFile: join(directory, 'base.toml'),
                lastGoodRuntimeConfigFile: join(directory, 'last-good.toml'),
                lockFile: join(directory, 'manager.lock'),
                runtimeConfigFile: join(directory, 'magic-sso.runtime.toml'),
                stateFile: join(directory, 'state.json'),
            },
        };
        await writeFile(
            settings.paths.baseConfigFile,
            `
[server]
appPort = 3000
appUrl = "http://localhost:3000"
logLevel = "error"
verifyTokenStoreDir = "/tmp/verification-tokens"
signInEmailRateLimitStoreDir = "/tmp/signin-rate-limit"
[server.reload]
secret = "${reloadSecret}"
[auth]
jwtSecret = "docker-jwt-secret-0123456789abcdefghij"
csrfSecret = "docker-csrf-secret-0123456789abcdefghij"
emailSecret = "docker-email-secret-0123456789abcdefghij"
previewSecret = "docker-preview-secret-0123456789abcdefghij"
[cookie]
secure = false
[email]
from = "owner@example.com"
[email.smtp]
host = "unused.example.com"
user = "unused"
pass = "unused"
[[sites]]
id = "client"
origins = ["http://client.example.com"]
allowedRedirectUris = ["http://client.example.com/*"]
allowedEmails = ["initial@example.com"]
`,
        );
        let containerCreated = false;
        try {
            const initial = updateSiteGrant(
                loadManagerStateOrEmpty(settings),
                settings,
                'client',
                'initial@example.com',
                ['*'],
            );
            persistManagerState(settings, initial);
            await applyManagerState(initial, settings);
            const serverScript = `
import { buildApp } from '/workspace/server/dist/app.js';
const emails = [];
const app = await buildApp({ logger: false, mailer: {
    async sendVerificationEmail(input) { emails.push(input.email); }
} });
app.get('/smoke/emails', async () => ({ emails }));
await app.listen({ host: '0.0.0.0', port: 3000 });
process.on('SIGTERM', async () => { await app.close(); process.exit(0); });
`;
            await docker([
                'run',
                '--detach',
                '--rm',
                '--name',
                name,
                '--publish',
                '127.0.0.1::3000',
                '--mount',
                `type=bind,src=${resolve('.')},dst=/workspace,readonly`,
                '--mount',
                `type=bind,src=${directory},dst=/app/runtime,readonly`,
                '--env',
                'MAGICSSO_CONFIG_FILE=/app/runtime/magic-sso.runtime.toml',
                '--workdir',
                '/workspace/server',
                process.env.MAGICSSO_DOCKER_NODE_IMAGE ?? 'node:24.15-slim',
                'node',
                '--input-type=module',
                '-e',
                serverScript,
            ]);
            containerCreated = true;
            const port = await docker(['port', name, '3000/tcp']);
            const origin = `http://${port}`;
            await waitForServer(origin);
            const startedAt = await docker(['inspect', '--format', '{{.State.StartedAt}}', name]);
            const signin = async (): Promise<void> => {
                const response = await fetch(`${origin}/signin`, {
                    method: 'POST',
                    headers: { 'content-type': 'application/json' },
                    body: JSON.stringify({
                        email: 'added@example.com',
                        returnUrl: 'http://client.example.com/',
                        verifyUrl: 'http://client.example.com/verify-email',
                    }),
                    signal: AbortSignal.timeout(5000),
                });
                expect(response.status).toBe(200);
            };
            await signin();
            expect(await (await fetch(`${origin}/smoke/emails`)).json()).toEqual({ emails: [] });
            const state = updateSiteGrant(
                loadManagerStateOrEmpty(settings),
                settings,
                'client',
                'added@example.com',
                ['*'],
            );
            persistManagerState(settings, state);
            await applyManagerState(state, settings);
            // Docker Desktop may propagate host directory changes asynchronously.
            await expect
                .poll(
                    async () => {
                        try {
                            return await docker([
                                'exec',
                                name,
                                'cat',
                                '/app/runtime/magic-sso.runtime.toml',
                            ]);
                        } catch {
                            return '';
                        }
                    },
                    { timeout: 5000 },
                )
                .toContain('added@example.com');
            settings.reload = {
                url: `${origin}/internal/access-config/reload`,
                secret: reloadSecret,
                timeoutMs: 5000,
            };
            expect(await reloadManagerRuntime(settings)).toEqual({
                reloaded: true,
                changedSiteIds: ['client'],
            });
            await signin();
            expect(await (await fetch(`${origin}/smoke/emails`)).json()).toEqual({
                emails: ['added@example.com'],
            });
            expect(await docker(['inspect', '--format', '{{.State.StartedAt}}', name])).toBe(
                startedAt,
            );
            expect(
                await docker(['exec', name, 'cat', '/app/runtime/magic-sso.runtime.toml']),
            ).toContain('added@example.com');
        } finally {
            if (containerCreated) {
                await docker(['rm', '--force', name]);
            }
            await rm(directory, { recursive: true, force: true });
        }
    }, 120_000);
});
