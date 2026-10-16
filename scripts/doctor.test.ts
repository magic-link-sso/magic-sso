// SPDX-License-Identifier: MIT

import { execFile } from 'node:child_process';
import { chmodSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { promisify } from 'node:util';
import { describe, expect, it } from 'vitest';

const execute = promisify(execFile);

describe('doctor root command', () => {
    it('explains the available targets', async () => {
        const { stdout } = await execute(process.execPath, ['scripts/doctor.mjs', '--help']);
        expect(stdout).toContain('pnpm doctor server|manager');
    });
    it('rejects unknown targets with exit code 2', async () => {
        await expect(
            execute(process.execPath, ['scripts/doctor.mjs', 'gate']),
        ).rejects.toMatchObject({ code: 2 });
    });
    it('forwards a caller-relative config and emits a single JSON report', async () => {
        const result = await execute(process.execPath, [
            'scripts/doctor.mjs',
            'server',
            '--config=scripts/fixtures/missing-doctor.toml',
            '--json',
        ]).catch((error: unknown) => {
            if (
                !(error instanceof Error) ||
                !('stdout' in error) ||
                typeof error.stdout !== 'string' ||
                !('code' in error)
            ) {
                throw error;
            }
            return { stdout: error.stdout, code: error.code };
        });
        expect(JSON.parse(result.stdout)).toMatchObject({
            component: 'server',
            checks: [
                expect.objectContaining({
                    status: 'fail',
                    setting: resolve('scripts/fixtures/missing-doctor.toml'),
                }),
                expect.objectContaining({ status: 'skip' }),
            ],
        });
    }, 30_000);
});

describe.skipIf(process.env.MAGICSSO_DOCKER_SMOKE !== '1')('doctor production images', () => {
    it.each(['server', 'manager'])(
        'builds and runs %s doctor as its production user',
        async (component) => {
            const image = `magic-sso-doctor-${component}:test`;
            await execute('docker', ['build', '-f', `${component}/Dockerfile`, '-t', image, '.'], {
                timeout: 240_000,
                maxBuffer: 4 * 1024 * 1024,
            });
            const directory = mkdtempSync(join(tmpdir(), 'doctor-image-'));
            chmodSync(directory, 0o755);
            try {
                const serverConfig = readFileSync('server/magic-sso.example.toml', 'utf8')
                    .replaceAll('replace-me-with', 'docker-fixture-with')
                    .replace('".magic-sso/verification-tokens"', '"/tmp/doctor/tokens"')
                    .replace('".magic-sso/signin-email-rate-limit"', '"/tmp/doctor/rate-limit"');
                writeFileSync(join(directory, 'server.toml'), serverConfig, { mode: 0o644 });
                writeFileSync(
                    join(directory, 'manager.toml'),
                    `managedSiteIds = ["nextjs-local"]
[audit]
integrityKey = "docker-doctor-audit-key-0123456789abcdef"
[paths]
baseConfigFile = "/diagnostic/server.toml"
stateFile = "/tmp/doctor/state.json"
runtimeConfigFile = "/tmp/doctor/runtime.toml"
lastGoodRuntimeConfigFile = "/tmp/doctor/last-good.toml"
auditFile = "/tmp/doctor/audit.ndjson"
lockFile = "/tmp/doctor/manager.lock"
`,
                    { mode: 0o644 },
                );
                const user = await execute('docker', [
                    'run',
                    '--rm',
                    '--entrypoint',
                    'id',
                    image,
                    '-u',
                ]);
                expect(user.stdout.trim()).toBe('1001');
                const entry =
                    component === 'server' ? ['dist/doctor.js'] : ['dist/cli.js', 'doctor'];
                const { stdout } = await execute(
                    'docker',
                    [
                        'run',
                        '--rm',
                        '-v',
                        `${directory}:/diagnostic:ro`,
                        '--entrypoint',
                        'node',
                        image,
                        ...entry,
                        '--config',
                        `/diagnostic/${component}.toml`,
                        '--json',
                    ],
                    { timeout: 30_000 },
                );
                const report: { component: string; checks: Array<{ status: string }> } =
                    JSON.parse(stdout);
                expect(report.component).toBe(component);
                expect(report.checks.some((check) => check.status === 'fail')).toBe(false);
                expect(readdirSync(directory).sort()).toEqual(['manager.toml', 'server.toml']);
            } finally {
                rmSync(directory, { recursive: true, force: true });
            }
        },
        300_000,
    );
});
