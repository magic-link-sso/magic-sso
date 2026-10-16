// SPDX-License-Identifier: MIT

import {
    chmodSync,
    existsSync,
    mkdirSync,
    mkdtempSync,
    readFileSync,
    readdirSync,
    rmSync,
    writeFileSync,
} from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { afterEach, describe, expect, it } from 'vitest';
import {
    checkConfiguration,
    checkDiagnosticPath,
    parseDoctorArguments,
    printDiagnosticReport,
    runDoctorCommand,
    withDiagnosticTimeout,
    type DiagnosticReport,
} from './diagnostics.js';

const directories: string[] = [];
function setup(): { directory: string; report: DiagnosticReport } {
    const directory = mkdtempSync(join(tmpdir(), 'doctor-paths-'));
    directories.push(directory);
    return { directory, report: { component: 'server', checks: [] } };
}
afterEach(() => {
    for (const directory of directories.splice(0)) {
        rmSync(directory, { recursive: true, force: true });
    }
});

describe('diagnostic arguments and reports', () => {
    it('runs diagnostics with a copied environment, config precedence and structured output', async () => {
        let output = '';
        const env = { MAGICSSO_CONFIG_FILE: 'environment.toml' };
        const code = await runDoctorCommand(
            'server',
            {
                argv: ['--config', 'explicit.toml', '--json'],
                env,
                stdout: {
                    write: (chunk) => {
                        output += chunk;
                    },
                },
            },
            async (args, resolvedEnv) => {
                expect(resolvedEnv.MAGICSSO_CONFIG_FILE).toBe('explicit.toml');
                expect(args.online).toBe(false);
                return { component: 'server', checks: [] };
            },
        );
        expect(code).toBe(0);
        expect(JSON.parse(output)).toEqual({ component: 'server', checks: [] });
        expect(env.MAGICSSO_CONFIG_FILE).toBe('environment.toml');
    });
    it('supports manager config, default arguments, help and sanitized usage failures', async () => {
        let output = '';
        const writer = {
            write: (chunk: string): void => {
                output += chunk;
            },
        };
        const diagnose = async (): Promise<DiagnosticReport> => ({
            component: 'manager',
            checks: [],
        });
        expect(
            await runDoctorCommand(
                'manager',
                { argv: ['--config', 'manager.toml'], stdout: writer },
                async (_args, env) => {
                    expect(env.MAGICSSO_MANAGER_CONFIG_FILE).toBe('manager.toml');
                    return diagnose();
                },
            ),
        ).toBe(0);
        expect(await runDoctorCommand('manager', { stdout: writer }, diagnose)).toBe(0);
        expect(
            await runDoctorCommand('manager', { argv: ['--help'], stdout: writer }, diagnose),
        ).toBe(0);
        expect(output).toContain('Options:');
        output = '';
        expect(
            await runDoctorCommand(
                'manager',
                { argv: ['--unknown=private'], stderr: writer },
                diagnose,
            ),
        ).toBe(2);
        expect(output).not.toContain('private');
    });
    it('uses bounded offline defaults and parses explicit options', () => {
        expect(parseDoctorArguments([])).toMatchObject({ online: false, timeoutMs: 5000 });
        expect(
            parseDoctorArguments([
                '--config',
                'config.toml',
                '--json',
                '--online',
                '--timeout-ms',
                '100',
            ]),
        ).toMatchObject({ config: 'config.toml', json: true, online: true, timeoutMs: 100 });
        expect(
            parseDoctorArguments(['--send-test-email', 'user@example.com'], true).recipient,
        ).toBe('user@example.com');
    });
    it.each([
        ['--timeout-ms', '99'],
        ['--timeout-ms', '30001'],
        ['--timeout-ms', '1e3'],
        ['--config', ''],
        ['--unknown'],
        ['extra'],
        ['--send-test-email', 'a@example.com'],
        ['--send-test-email', 'a@example.com,b@example.com'],
    ])('rejects invalid arguments %j', (...args) => {
        expect(() => parseDoctorArguments(args)).toThrow();
    });
    it('rejects multiple recipients even when email sending is enabled', () => {
        expect(() =>
            parseDoctorArguments(['--send-test-email', 'a@example.com,b@example.com'], true),
        ).toThrow();
    });
    it('redacts parser excerpts and reports safe field names', () => {
        const { report } = setup();
        checkConfiguration(report, 'syntax', 'config.toml', () => {
            throw new Error('Bad TOML: pass = "super-secret"');
        });
        checkConfiguration(report, 'semantic', 'config.toml', () => {
            throw new Error('auth.jwtSecret must be longer: super-secret');
        });
        expect(JSON.stringify(report)).not.toContain('super-secret');
        expect(report.checks[1]?.setting).toContain('auth.jwtSecret');
        let text = '';
        expect(
            printDiagnosticReport(report, false, {
                write: (chunk) => {
                    text += chunk;
                },
            }),
        ).toBe(1);
        expect(text).toContain('[fail] syntax');
        let json = '';
        printDiagnosticReport(report, true, {
            write: (chunk) => {
                json += chunk;
            },
        });
        expect(JSON.parse(json)).toEqual(report);
    });
    it('aborts and rejects a stalled operation', async () => {
        let aborted = false;
        await expect(
            withDiagnosticTimeout(
                20,
                (signal) =>
                    new Promise<void>(() => {
                        signal.addEventListener('abort', () => {
                            aborted = true;
                        });
                    }),
            ),
        ).rejects.toThrow('timed out');
        expect(aborted).toBe(true);
    });
});

describe('read-only filesystem checks', () => {
    it('checks existing and future directories without creating anything', () => {
        const { directory, report } = setup();
        const file = join(directory, 'config.toml');
        writeFileSync(file, 'unchanged');
        expect(checkDiagnosticPath(report, 'config', file)).toBe(true);
        expect(
            checkDiagnosticPath(report, 'future', join(directory, 'new', 'store'), {
                directory: true,
                writable: true,
                optional: true,
            }),
        ).toBe(false);
        expect(report.checks.map((check) => check.status)).toEqual(['pass', 'warn']);
        expect(readdirSync(directory)).toEqual(['config.toml']);
        expect(readFileSync(file, 'utf8')).toBe('unchanged');
        expect(existsSync(join(directory, 'new'))).toBe(false);
    });
    it('distinguishes missing required files and invalid ancestor types', () => {
        const { directory, report } = setup();
        const file = join(directory, 'file');
        writeFileSync(file, '');
        checkDiagnosticPath(report, 'required', join(directory, 'missing'));
        checkDiagnosticPath(report, 'wrong-type', file, { directory: true });
        checkDiagnosticPath(report, 'ancestor', join(file, 'state'), { optional: true });
        expect(report.checks.every((check) => check.status === 'fail')).toBe(true);
    });
    it('checks directory permissions needed for atomic replacement and bootstrap', () => {
        const { directory, report } = setup();
        const readonly = join(directory, 'readonly');
        mkdirSync(readonly);
        const file = join(readonly, 'runtime.toml');
        writeFileSync(file, 'readable');
        chmodSync(readonly, 0o500);
        try {
            checkDiagnosticPath(report, 'atomic', file, { replaceable: true });
            checkDiagnosticPath(report, 'bootstrap', join(readonly, 'missing'), { optional: true });
            expect(report.checks.every((check) => check.status === 'fail')).toBe(true);
        } finally {
            chmodSync(readonly, 0o700);
        }
    });
});
