// SPDX-License-Identifier: GPL-3.0-or-later

import { createServer, type Server } from 'node:http';
import { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { runCli } from './cli.js';
import { loadManagerRuntimeSettings } from './settings.js';
import { buildRuntimePlan } from './runtime.js';
import { loadManagerStateOrEmpty, updateSiteGrant } from './service.js';
import { stringifyManagerState } from './state.js';
import type { DiagnosticReport } from '@magic-link-sso/config-core/diagnostics';

const directories: string[] = [];
const servers: Server[] = [];
const reloadSecret = 'doctor-reload-secret-0123456789abcdef';
function setup(): {
    path: string;
    directory: string;
    env: NodeJS.ProcessEnv;
    settingsSource: string;
} {
    const directory = mkdtempSync(join(tmpdir(), 'doctor-manager-'));
    directories.push(directory);
    const base = readFileSync(
        new URL('../../server/magic-sso.example.toml', import.meta.url),
        'utf8',
    )
        .replaceAll('replace-me-with', 'manager-fixture-with')
        .replace('# [server.reload]', '[server.reload]')
        .replace(
            '# secret = "manager-fixture-with-a-dedicated-long-random-reload-secret"',
            `secret = "${reloadSecret}"`,
        );
    writeFileSync(join(directory, 'base.toml'), base);
    const settingsSource = `managedSiteIds = ["nextjs-local"]
[audit]
integrityKey = "doctor-audit-secret-0123456789abcdef"
[paths]
baseConfigFile = "base.toml"
stateFile = "generated/state.json"
runtimeConfigFile = "generated/runtime.toml"
lastGoodRuntimeConfigFile = "generated/last-good.toml"
auditFile = "generated/audit.ndjson"
lockFile = "generated/manager.lock"
[reload]
url = "http://127.0.0.1:1/internal/access-config/reload"
secret = "${reloadSecret}"
`;
    const path = join(directory, 'manager.toml');
    writeFileSync(path, settingsSource);
    return { path, directory, env: { MAGICSSO_MANAGER_CONFIG_FILE: path }, settingsSource };
}
async function run(
    env: NodeJS.ProcessEnv,
    args: string[] = [],
    fetchImplementation?: typeof fetch,
): Promise<{ code: number; report: DiagnosticReport; output: string }> {
    let output = '';
    const code = await runCli({
        argv: ['doctor', '--json', ...args],
        env,
        stdout: {
            write: (chunk) => {
                output += chunk;
            },
        },
        fetchImplementation,
    });
    return { code, report: JSON.parse(output), output };
}
afterEach(async () => {
    for (const server of servers.splice(0)) {
        server.closeAllConnections();
        await new Promise<void>((resolve) => server.close(() => resolve()));
    }
    for (const directory of directories.splice(0)) {
        rmSync(directory, { recursive: true, force: true });
    }
});

describe('manager doctor', () => {
    it('handles bootstrap without writing state, locks, audit or runtime or contacting reload', async () => {
        const fixture = setup();
        const fetcher = vi.fn<typeof fetch>();
        const before = readdirSync(fixture.directory);
        const result = await run(
            { MAGICSSO_MANAGER_CONFIG_FILE: '/missing' },
            ['--config', fixture.path],
            fetcher,
        );
        expect(result.code).toBe(0);
        expect(result.report.checks.find((check) => check.id === 'runtime.candidate')?.status).toBe(
            'skip',
        );
        expect(result.report.checks.find((check) => check.id === 'managed-sites')?.status).toBe(
            'pass',
        );
        expect(result.report.checks.find((check) => check.id === 'runtime.path')?.status).toBe(
            'warn',
        );
        expect(readdirSync(fixture.directory)).toEqual(before);
        expect(fetcher).not.toHaveBeenCalled();
        expect(result.output).not.toContain(reloadSecret);
    });
    it.each(['settings', 'base', 'state', 'runtime', 'managed-site', 'secret'])(
        'fails invalid %s while retaining independent results',
        async (kind) => {
            const fixture = setup();
            const mutations: Record<string, () => void> = {
                settings: () => writeFileSync(fixture.path, '[reload]\nsecret="do-not-leak'),
                base: () =>
                    writeFileSync(
                        join(fixture.directory, 'base.toml'),
                        '[auth]\njwtSecret="do-not-leak',
                    ),
                state: () =>
                    writeFileSync(
                        fixture.path,
                        fixture.settingsSource.replace('generated/state.json', 'base.toml'),
                    ),
                runtime: () =>
                    writeFileSync(
                        fixture.path,
                        fixture.settingsSource.replace('generated/runtime.toml', 'manager.toml'),
                    ),
                'managed-site': () =>
                    writeFileSync(
                        fixture.path,
                        fixture.settingsSource.replace('nextjs-local', 'missing-site'),
                    ),
                secret: () =>
                    writeFileSync(
                        fixture.path,
                        fixture.settingsSource.replace(
                            reloadSecret,
                            'different-reload-secret-0123456789abcdef',
                        ),
                    ),
            };
            mutations[kind]?.();
            const result = await run(fixture.env);
            expect(result.code).toBe(1);
            expect(result.output).not.toContain('do-not-leak');
            expect(result.output).not.toContain(reloadSecret);
        },
    );
    it('reports saved changes and drift without claiming the runtime is active', async () => {
        const fixture = setup();
        const source = fixture.settingsSource.replaceAll('generated/', '');
        writeFileSync(fixture.path, source);
        const settings = loadManagerRuntimeSettings({ env: fixture.env });
        const initial = updateSiteGrant(
            loadManagerStateOrEmpty(settings),
            settings,
            'nextjs-local',
            'initial@example.com',
            ['*'],
        );
        const plan = buildRuntimePlan(initial, settings);
        writeFileSync(settings.paths.runtimeConfigFile, plan.runtimeToml);
        const changed = updateSiteGrant(initial, settings, 'nextjs-local', 'new@example.com', [
            '*',
        ]);
        writeFileSync(
            settings.paths.stateFile,
            stringifyManagerState({
                ...changed,
                metadata: {
                    lastAppliedBaseConfigHash: 'old-base-hash',
                    lastAppliedRuntimeConfigHash: plan.runtimeConfigHash,
                },
            }),
        );
        const result = await run(fixture.env);
        expect(result.code).toBe(0);
        expect(result.report.checks.find((check) => check.id === 'runtime.pending')).toMatchObject({
            status: 'warn',
            message: expect.stringContaining('active server state is unverified'),
        });
    });
    it.each([200, 403, 404, 405, 500])(
        'checks reload HTTP %i with GET, a secret, no redirects and no POST',
        async (status) => {
            const fixture = setup();
            const fetcher = vi.fn<typeof fetch>(
                async () =>
                    new Response(JSON.stringify({ status: 'ok', reloadEnabled: true }), { status }),
            );
            const result = await run(fixture.env, ['--online'], fetcher);
            const expected =
                status === 200 ? 'pass' : status === 404 || status === 405 ? 'warn' : 'fail';
            expect(
                result.report.checks.find((check) => check.id === 'reload.connection')?.status,
            ).toBe(expected);
            expect(fetcher).toHaveBeenCalledWith(
                expect.any(String),
                expect.objectContaining({
                    method: 'GET',
                    redirect: 'error',
                    headers: { 'x-magic-sso-reload-secret': reloadSecret },
                    signal: expect.any(AbortSignal),
                }),
            );
            expect(result.output).not.toContain(reloadSecret);
        },
    );
    it('rejects successful responses with unexpected payloads', async () => {
        const fixture = setup();
        const fetcher = vi.fn<typeof fetch>(async () => new Response('{"status":"ok"}'));
        expect((await run(fixture.env, ['--online'], fetcher)).code).toBe(1);
    });
    it('bounds real HTTP responses with stalled bodies and refuses redirects', async () => {
        const fixture = setup();
        let redirected = false;
        const server = createServer((request, response) => {
            if (request.url === '/redirect') {
                response.writeHead(302, { location: '/target' });
                response.end();
            } else if (request.url === '/target') {
                redirected = true;
                response.end('{}');
            } else {
                response.writeHead(200, { 'content-type': 'application/json' });
                response.write('{');
            }
        });
        servers.push(server);
        await new Promise<void>((resolve, reject) => {
            server.once('error', reject);
            server.listen(0, '127.0.0.1', resolve);
        });
        const address = server.address();
        if (!address || typeof address === 'string') {
            throw new Error('Expected TCP address');
        }
        for (const path of ['/stall', '/redirect']) {
            writeFileSync(
                fixture.path,
                fixture.settingsSource.replace(
                    'http://127.0.0.1:1/internal/access-config/reload',
                    `http://127.0.0.1:${address.port}${path}`,
                ),
            );
            const start = Date.now();
            const result = await run(fixture.env, ['--online', '--timeout-ms', '100']);
            expect(result.code).toBe(1);
            expect(Date.now() - start).toBeLessThan(1500);
        }
        expect(redirected).toBe(false);
    });
    it('rejects email sending and invalid arguments before loading settings', async () => {
        let error = '';
        const code = await runCli({
            argv: ['doctor', '--send-test-email', 'secret@example.com'],
            env: {},
            stderr: {
                write: (chunk) => {
                    error += chunk;
                },
            },
        });
        expect(code).toBe(2);
        expect(error).not.toContain('secret@example.com');
    });
});
