// SPDX-License-Identifier: GPL-3.0-or-later

import { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { runServerDoctor } from './doctor.js';
import type { DiagnosticReport } from '@magic-link-sso/config-core/diagnostics';

const directories: string[] = [];
function setup(): { directory: string; path: string; source: string } {
    const directory = mkdtempSync(join(tmpdir(), 'doctor-server-'));
    directories.push(directory);
    const path = join(directory, 'config.toml');
    const source = readFileSync(new URL('../magic-sso.example.toml', import.meta.url), 'utf8')
        .replaceAll('replace-me-with', 'doctor-fixture-with')
        .replace(
            'verifyTokenStoreDir = ".magic-sso/verification-tokens"',
            `verifyTokenStoreDir = "${directory}/tokens"`,
        )
        .replace(
            'signInEmailRateLimitStoreDir = ".magic-sso/signin-email-rate-limit"',
            `signInEmailRateLimitStoreDir = "${directory}/rate-limit"`,
        );
    writeFileSync(path, source);
    return { directory, path, source };
}
async function run(
    argv: string[],
    env: NodeJS.ProcessEnv = {},
): Promise<{ code: number; report: DiagnosticReport; output: string }> {
    let output = '';
    const code = await runServerDoctor({
        argv: ['--json', ...argv],
        env,
        stdout: {
            write: (chunk) => {
                output += chunk;
            },
        },
    });
    return { code, report: JSON.parse(output), output };
}
afterEach(() => {
    vi.unstubAllGlobals();
    for (const directory of directories.splice(0)) {
        rmSync(directory, { recursive: true, force: true });
    }
});

describe('server doctor', () => {
    it('validates offline without contacting dependencies or creating stores', async () => {
        const { path, source, directory } = setup();
        const fetch = vi.fn();
        vi.stubGlobal('fetch', fetch);
        const result = await run(['--config', path], {
            MAGICSSO_CONFIG_FILE: '/missing/env-config',
        });
        expect(result.code).toBe(0);
        expect(result.report.checks.find((check) => check.id === 'smtp')?.status).toBe('skip');
        expect(fetch).not.toHaveBeenCalled();
        expect(readdirSync(directory)).toEqual(['config.toml']);
        expect(readFileSync(path, 'utf8')).toBe(source);
        expect(result.output).not.toContain('smtp-password');
        expect(result.output).not.toContain('replace-me-with-a-long-random-jwt-secret');
    });
    it.each(['missing', 'syntax', 'callback', 'duplicate'])(
        'reports %s configuration failures with skipped dependent checks',
        async (kind) => {
            const { path, source } = setup();
            const changes: Record<string, string> = {
                syntax: '[auth]\njwtSecret = "do-not-leak',
                callback: source.replace(
                    'http://localhost:3001/verify-email',
                    'https://evil.example/verify-email',
                ),
                duplicate: source.replace('id = "nuxt-local"', 'id = "nextjs-local"'),
            };
            if (kind !== 'missing') {
                writeFileSync(path, changes[kind] ?? '');
            }
            const result = await run(['--config', kind === 'missing' ? `${path}.missing` : path]);
            expect(result.code).toBe(1);
            expect(result.report.checks[0]?.status).toBe('fail');
            expect(result.report.checks[1]?.status).toBe('skip');
            expect(result.output).not.toContain('do-not-leak');
        },
    );
    it('marks Redis connectivity as unverified even in online mode', async () => {
        const { path, source } = setup();
        writeFileSync(
            path,
            source.replace(
                'adapter = "file"',
                'adapter = "redis"\nredisUrl = "redis://localhost:6379"',
            ),
        );
        const result = await run(['--config', path]);
        expect(result.report.checks.find((check) => check.id === 'storage.redis')?.status).toBe(
            'skip',
        );
        expect(result.report.checks.some((check) => check.id.startsWith('storage.0'))).toBe(false);
    });
    it('supports help and rejects invalid flags without exposing their values', async () => {
        let output = '';
        const writer = {
            write: (chunk: string): void => {
                output += chunk;
            },
        };
        expect(await runServerDoctor({ argv: ['--help'], stdout: writer })).toBe(0);
        expect(output).toContain('--send-test-email');
        output = '';
        expect(await runServerDoctor({ argv: ['--secret=do-not-leak'], stderr: writer })).toBe(2);
        expect(output).not.toContain('do-not-leak');
    });
});
