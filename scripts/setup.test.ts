// SPDX-License-Identifier: MIT
import { execFile } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { parseEnv } from 'node:util';
import { promisify } from 'node:util';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
    parseMagicSsoConfigToml,
    parseMagicSsoTomlConfig,
} from '../packages/config-core/src/index.js';
import { loadConfig as loadGateConfig } from '../gate/src/config.js';
import { runServerDoctor } from '../server/src/doctor.js';
import { createStarterFiles, writeStarter, runSetup, type StarterOptions } from './setup.mjs';

const execute = promisify(execFile);
const originalTty = Object.getOwnPropertyDescriptor(process.stdin, 'isTTY');
beforeEach(() => {
    Object.defineProperty(process.stdin, 'isTTY', { configurable: true, value: false });
});
const directories: string[] = [];
function directory(): string {
    const path = mkdtempSync(join(tmpdir(), 'magic-sso-setup-'));
    directories.push(path);
    return path;
}
afterEach(() => {
    vi.restoreAllMocks();
    if (originalTty) {
        Object.defineProperty(process.stdin, 'isTTY', originalTty);
    } else {
        Reflect.deleteProperty(process.stdin, 'isTTY');
    }
    for (const path of directories.splice(0)) {
        rmSync(path, { recursive: true, force: true });
    }
});

describe('first-deployment setup', () => {
    it('runs help and input validation without creating a deployment', async () => {
        const stdout = vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
        const stderr = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
        expect(await runSetup(['--help'])).toBe(0);
        expect(stdout.mock.calls.map(([value]) => String(value)).join('')).toContain(
            'pnpm setup:app gate|sdk',
        );
        for (const args of [[], ['unknown'], ['gate', 'sdk'], ['gate', '--force'], ['sdk']]) {
            expect(await runSetup(args)).toBe(2);
        }
        expect(stderr.mock.calls.map(([value]) => String(value)).join('')).toContain(
            'Setup failed:',
        );
    });

    it('maps CLI options into private configuration and refuses to overwrite it', async () => {
        const stdout = vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
        const stderr = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
        const output = join(directory(), 'direct-cli');
        const args = [
            'gate',
            '--email',
            'Owner@Example.com',
            '--output',
            output,
            '--server-port',
            '3333',
            '--app-port',
            '4444',
            '--smtp-port',
            '2525',
            '--trust-proxy',
        ];
        expect(await runSetup(args)).toBe(0);
        const source = readFileSync(join(output, 'magic-sso.toml'), 'utf8');
        const config = parseMagicSsoConfigToml(source, 'starter');
        expect(config.appPort).toBe(3333);
        expect(config.emailSmtpPort).toBe(2525);
        expect(config.trustProxy).toBe(true);
        expect(
            loadGateConfig({ MAGIC_GATE_CONFIG_FILE: join(output, 'magic-gate.toml') }).port,
        ).toBe(4444);
        const transcript = stdout.mock.calls.map(([value]) => String(value)).join('');
        expect(transcript).toContain('NEXT-STEPS.md');
        expect(transcript).not.toContain(config.jwtSecret);
        expect(await runSetup(args)).toBe(2);
        expect(readFileSync(join(output, 'magic-sso.toml'), 'utf8')).toBe(source);
        expect(stderr.mock.calls.map(([value]) => String(value)).join('')).toContain(
            'Output already exists',
        );
    });
    it.each(['gate', 'sdk'] satisfies StarterOptions['path'][])(
        'passes offline server diagnostics for the generated %s config',
        async (path) => {
            const output = writeStarter({
                path,
                emails: ['owner@example.com'],
                output: join(directory(), path),
            });
            let reportJson = '';
            const status = await runServerDoctor({
                argv: ['--config', join(output, 'magic-sso.toml'), '--json'],
                env: {},
                stdout: {
                    write: (chunk: string): void => {
                        reportJson += chunk;
                    },
                },
            });
            expect(status).toBe(0);
            const report: { checks: { status: string }[] } = JSON.parse(reportJson);
            expect(report.checks.some((check) => check.status === 'fail')).toBe(false);
        },
    );
    it('generates matching Gate/server settings, distinct random secrets, and normalized grants', () => {
        const output = writeStarter({
            path: 'gate',
            output: join(directory(), 'gate'),
            emails: [' Owner@Example.com ', 'owner@example.com', 'friend@example.com'],
        });
        const server = parseMagicSsoConfigToml(
            readFileSync(join(output, 'magic-sso.toml'), 'utf8'),
            'starter',
        );
        const gate = loadGateConfig({ MAGIC_GATE_CONFIG_FILE: join(output, 'magic-gate.toml') });
        const raw = parseMagicSsoTomlConfig(
            readFileSync(join(output, 'magic-sso.toml'), 'utf8'),
            'starter',
        );
        expect(raw.sites[0]).toMatchObject({
            id: 'starter',
            origins: [gate.publicOrigin],
            allowedEmails: ['owner@example.com', 'friend@example.com'],
        });
        expect(raw.sites[0]?.allowedRedirectUris).toContain(
            `${gate.publicOrigin}/_magicgate/verify-email`,
        );
        expect(gate.jwtSecret).toBe(server.jwtSecret);
        expect(gate.previewSecret).toBe(server.previewSecret);
        expect(gate.serverUrl).toBe(server.appUrl);
        expect(gate.cookieName).toBe(server.cookieName);
        expect(gate.upstreamUrl).toBe('http://127.0.0.1:3007');
        expect(
            new Set([server.jwtSecret, server.csrfSecret, server.emailSecret, server.previewSecret])
                .size,
        ).toBe(4);
        for (const secret of [
            server.jwtSecret,
            server.csrfSecret,
            server.emailSecret,
            server.previewSecret,
        ]) {
            expect(secret.length).toBeGreaterThanOrEqual(32);
        }
        const fresh = createStarterFiles({ path: 'gate', emails: ['owner@example.com'] });
        expect(fresh['magic-sso.toml']).not.toContain(server.jwtSecret);
        expect(server.verifyTokenStoreDir).toBe(join(output, 'state/verification-tokens'));
        expect(statSync(output).mode & 0o777).toBe(0o700);
        expect(statSync(join(output, 'magic-sso.toml')).mode & 0o777).toBe(0o600);
    });

    it('creates a standalone strict Next.js app with aligned server-only environment', () => {
        const output = writeStarter({
            path: 'sdk',
            output: join(directory(), 'sdk'),
            emails: ['owner@example.com'],
        });
        const server = parseMagicSsoConfigToml(
            readFileSync(join(output, 'magic-sso.toml'), 'utf8'),
            'starter',
        );
        const env = parseEnv(readFileSync(join(output, 'app/.env.local'), 'utf8'));
        expect(env).toMatchObject({
            MAGICSSO_JWT_SECRET: server.jwtSecret,
            MAGICSSO_PREVIEW_SECRET: server.previewSecret,
            MAGICSSO_COOKIE_NAME: server.cookieName,
            MAGICSSO_SERVER_URL: server.appUrl,
            MAGICSSO_PUBLIC_ORIGIN: 'http://localhost:3001',
            MAGICSSO_DIRECT_USE: 'true',
        });
        expect(Object.keys(env).some((key) => key.startsWith('NEXT_PUBLIC_'))).toBe(false);
        expect(readFileSync(join(output, 'app/.env.local'), 'utf8')).not.toContain(
            server.csrfSecret,
        );
        expect(
            JSON.parse(readFileSync(join(output, 'app/tsconfig.json'), 'utf8')).compilerOptions
                .strict,
        ).toBe(true);
        const manifest = JSON.parse(readFileSync(join(output, 'app/package.json'), 'utf8'));
        expect(manifest.dependencies['@magic-link-sso/nextjs']).not.toContain('workspace:');
        expect(Object.values(manifest.dependencies)).not.toContain('*');
        expect(Object.values(manifest.devDependencies)).not.toContain('*');
        expect(manifest.scripts.dev).toContain('--port 3001');
        expect(manifest.scripts.start).toContain('--port 3001');
        expect(existsSync(join(output, 'app/src/app/verify-email/route.ts'))).toBe(true);
        expect(readFileSync(join(output, '.gitignore'), 'utf8')).toContain('app/.env*');
        expect(readFileSync(join(output, 'app/.gitignore'), 'utf8')).toContain('.env*');
        expect(statSync(join(output, 'app/.env.local')).mode & 0o777).toBe(0o600);
    });

    it('typechecks the generated SDK app against the workspace SDK', async () => {
        const output = writeStarter({
            path: 'sdk',
            output: join(directory(), 'sdk'),
            emails: ['owner@example.com'],
        });
        symlinkSync(
            resolve('examples/nextjs/node_modules'),
            join(output, 'app/node_modules'),
            'dir',
        );
        await execute(process.execPath, [
            resolve('examples/nextjs/node_modules/typescript/bin/tsc'),
            '--noEmit',
            '-p',
            join(output, 'app/tsconfig.json'),
        ]);
    }, 30_000);

    it('generates HTTPS configs with explicit SMTP and separate public and listen ports', () => {
        const output = writeStarter({
            path: 'gate',
            emails: ['owner@example.com'],
            output: join(directory(), 'https'),
            serverOrigin: 'https://sso.example.com:8443',
            appOrigin: 'https://private.example.com:9443',
            smtpHost: 'smtp.example.com',
            smtpUser: 'operator',
            smtpPassword: 'a"b\\c\n$',
            emailFrom: 'signin@example.com',
            upstreamUrl: 'http://127.0.0.1:8080',
            trustProxy: true,
        });
        const server = parseMagicSsoConfigToml(
            readFileSync(join(output, 'magic-sso.toml'), 'utf8'),
            'starter',
        );
        const gate = loadGateConfig({ MAGIC_GATE_CONFIG_FILE: join(output, 'magic-gate.toml') });
        expect(server.cookieSecure).toBe(true);
        expect(server.appPort).toBe(3000);
        expect(gate.port).toBe(4000);
        expect(server.emailSmtpPass).toBe('a"b\\c\n$');
        expect(gate.publicOrigin).toBe('https://private.example.com:9443');
    });

    it.each<Partial<StarterOptions>>([
        { emails: [] },
        { emails: ['not-an-email'] },
        { emails: ['person@example..com'] },
        { emails: ['.person@example.com'] },
        { emailFrom: 'invalid-sender' },
        { siteId: '../escape' },
        { serverOrigin: 'http://public.example.com' },
        { appOrigin: 'https://user:pass@example.com' },
        { appOrigin: 'http://localhost:4000/path' },
        { appOrigin: 'http://localhost:3000' },
        { serverPort: 0 },
        { appPort: 70000 },
        { smtpPort: 1.5 },
        { upstreamUrl: 'file:///etc/passwd' },
        { serverOrigin: 'https://sso.example.com' },
    ])('rejects invalid input before creating output (%j)', (overrides) => {
        const output = join(directory(), 'invalid');
        expect(() =>
            writeStarter({ path: 'gate', emails: ['owner@example.com'], output, ...overrides }),
        ).toThrow();
        expect(existsSync(output)).toBe(false);
    });

    it('refuses existing directories and symlinks without rotating secrets or touching their files', () => {
        const parent = directory();
        const output = writeStarter({
            path: 'gate',
            output: join(parent, 'gate'),
            emails: ['owner@example.com'],
        });
        const original = readFileSync(join(output, 'magic-sso.toml'), 'utf8');
        expect(() =>
            writeStarter({ path: 'gate', output, emails: ['another@example.com'] }),
        ).toThrow();
        expect(readFileSync(join(output, 'magic-sso.toml'), 'utf8')).toBe(original);
        const link = join(parent, 'link');
        symlinkSync(output, link, 'dir');
        expect(() =>
            writeStarter({ path: 'sdk', output: link, emails: ['owner@example.com'] }),
        ).toThrow();
        expect(readFileSync(join(output, 'magic-sso.toml'), 'utf8')).toBe(original);
    });

    it('supports CLI help, noninteractive generation and actionable input failures without printing secrets', async () => {
        const script = resolve('scripts/setup.mjs');
        const { stdout: help } = await execute('pnpm', ['setup:app', '--help']);
        expect(help).toContain('pnpm setup:app gate|sdk');
        const output = join(directory(), 'cli');
        const { stdout } = await execute(process.execPath, [
            script,
            'gate',
            '--email',
            'owner@example.com',
            '--output',
            output,
        ]);
        const server = parseMagicSsoConfigToml(
            readFileSync(join(output, 'magic-sso.toml'), 'utf8'),
            'starter',
        );
        expect(stdout).toContain('NEXT-STEPS.md');
        expect(stdout).not.toContain(server.jwtSecret);
        await expect(execute(process.execPath, [script, 'sdk'])).rejects.toMatchObject({
            code: 2,
            stderr: expect.stringContaining('--email'),
        });
        await expect(execute(process.execPath, [script, 'unknown'])).rejects.toMatchObject({
            code: 2,
        });
        await expect(execute(process.execPath, [script, 'gate', '--force'])).rejects.toMatchObject({
            code: 2,
        });
    });
});
