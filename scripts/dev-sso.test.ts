// SPDX-License-Identifier: MIT
import { spawn, type ChildProcess } from 'node:child_process';
import { mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
    loadConfig,
    parseMagicSsoTomlConfig,
    stringifyMagicSsoTomlConfig,
} from '../packages/config-core/src/index.js';
import { loadConfig as loadGateConfig } from '../gate/src/config.js';
import {
    createDevSsoConfig,
    createDevSsoJobs,
    DEV_SSO_APPS,
    devSsoOrigin,
} from './dev-sso-config.mjs';
import { buildDevSsoPackages, runDevSsoJobs, runSsoDev, parseDevSsoArgs } from './dev-sso.mjs';

const inboxOptions = { inbox: true, email: 'developer@example.com' };
const directories: string[] = [];
afterEach(async (): Promise<void> => {
    vi.restoreAllMocks();
    await Promise.all(
        directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })),
    );
});

async function directory(): Promise<string> {
    const value = await mkdtemp(join(tmpdir(), 'magic-sso-dev-test-'));
    directories.push(value);
    return value;
}

describe('shared SSO development profiles', () => {
    it('uses the familiar application ports and starts a mailbox only on request', (): void => {
        expect(Object.fromEntries(DEV_SSO_APPS.map((app) => [app.id, app.port]))).toEqual({
            angular: 3004,
            nextjs: 3001,
            nuxt: 3002,
            django: 8000,
            fastify: 3005,
            photos: 5001,
            private1: 4000,
            private2: 4001,
        });
        expect(createDevSsoJobs('/tmp/dev').some((job) => job.id === 'mail')).toBe(false);
        expect(
            createDevSsoJobs('/tmp/dev', true).find((job) => job.id === 'mail')?.env,
        ).toMatchObject({
            MAIL_SINK_HTTP_PORT: '8025',
            MAIL_SINK_SMTP_PORT: '1025',
        });
    });

    it('supports a personal address and optional local inbox in both form profiles', (): void => {
        expect(parseDevSsoArgs([])).toEqual({ loginUi: 'hosted' });
        expect(parseDevSsoArgs(['--email', ' Me@Example.org ', '--inbox', '--local'])).toEqual({
            loginUi: 'app-owned',
            email: 'me@example.org',
            inbox: true,
        });
        expect(() => parseDevSsoArgs(['--email'])).toThrow('valid email');
        expect(() => parseDevSsoArgs(['--email', 'invalid'])).toThrow('valid email');
        expect(() => parseDevSsoArgs(['--unknown'])).toThrow('Usage:');
    });

    it('preserves SMTP delivery and per-site grants from the existing server configuration', async (): Promise<void> => {
        const root = await directory();
        const source = parseMagicSsoTomlConfig(
            stringifyMagicSsoTomlConfig(createDevSsoConfig(root, 'hosted', inboxOptions).issuer),
            'source fixture',
        );
        const next = source.sites.find((site) => site.id === 'nextjs');
        if (!next) {
            throw new Error('Missing Next.js fixture');
        }
        source.sites = [
            {
                ...next,
                id: 'nextjs-local',
                origins: ['http://localhost:3001'],
                allowedEmails: ['me@example.org'],
                accessRules: [{ email: 'scoped@example.org', scopes: ['reports'] }],
            },
        ];
        source.email.smtp = {
            ...source.email.smtp,
            host: 'smtp.example.org',
            port: 587,
            user: 'smtp-user',
            pass: 'test-only-password',
        };
        const original = structuredClone(source);
        const config = createDevSsoConfig(root, 'hosted', { source });
        expect(config.issuer.email).toEqual(source.email);
        const path = join(root, 'mapped.toml');
        await writeFile(path, stringifyMagicSsoTomlConfig(config.issuer));
        const mapped = loadConfig({ MAGICSSO_CONFIG_FILE: path });
        const mappedNext = mapped.sites.find((site) => site.id === 'nextjs-local');
        expect(mappedNext?.origins).toEqual(new Set(['http://nextjs.localhost:3001']));
        expect(mappedNext?.accessRules.get('me@example.org')).toEqual(new Set(['*']));
        expect(mappedNext?.accessRules.get('scoped@example.org')).toEqual(new Set(['reports']));
        expect(mapped.sites.find((site) => site.id === 'private1')).toBeUndefined();
        const ownAddress = createDevSsoConfig(root, 'app-owned', {
            source,
            email: 'personal@example.org',
        });
        await writeFile(path, stringifyMagicSsoTomlConfig(ownAddress.issuer));
        expect(
            loadConfig({ MAGICSSO_CONFIG_FILE: path }).sites.every((site) =>
                site.accessRules.get('personal@example.org')?.has('*'),
            ),
        ).toBe(true);
        expect(source).toEqual(original);
        expect(
            createDevSsoConfig(root, 'hosted', { source, inbox: true }).issuer.email,
        ).toMatchObject({ smtp: { host: '127.0.0.1', port: 1025 } });
        expect(() => createDevSsoConfig(root, 'hosted')).toThrow(
            'existing server email configuration',
        );
        source.sites[0].id = 'custom-next';
        expect(createDevSsoConfig(root, 'hosted', { source }).issuer.sites).toEqual(
            expect.arrayContaining([expect.objectContaining({ id: 'custom-next' })]),
        );
    });

    it('loads the normal MAGICSSO_CONFIG_FILE without changing its SMTP or sending email', async (): Promise<void> => {
        const root = await directory();
        const sourcePath = join(root, 'local.toml');
        const sourceContents = stringifyMagicSsoTomlConfig(
            createDevSsoConfig(root, 'hosted', inboxOptions).issuer,
        );
        await writeFile(sourcePath, sourceContents);
        vi.spyOn(console, 'log').mockImplementation(() => undefined);
        let loaded = false;
        await expect(
            runSsoDev({
                loginUi: 'hosted',
                signal: new AbortController().signal,
                env: { MAGICSSO_CONFIG_FILE: sourcePath },
                buildFn: () => 0,
                runJobsFn: async (jobs): Promise<number> => {
                    expect(jobs.some((job) => job.id === 'mail')).toBe(false);
                    const generated = jobs.find((job) => job.id === 'issuer')?.env
                        .MAGICSSO_CONFIG_FILE;
                    if (!generated) {
                        throw new Error('Missing generated issuer config');
                    }
                    const parsed = parseMagicSsoTomlConfig(
                        await readFile(generated, 'utf8'),
                        generated,
                    );
                    expect(parsed.email).toEqual(
                        parseMagicSsoTomlConfig(sourceContents, sourcePath).email,
                    );
                    loaded = true;
                    return 0;
                },
            }),
        ).resolves.toBe(0);
        expect(loaded).toBe(true);
        expect(await readFile(sourcePath, 'utf8')).toBe(sourceContents);
    });

    it('builds config-core and the framework packages before a fresh development run', (): void => {
        const spawnSyncFn = vi.fn(() => ({ status: 0 }));
        expect(buildDevSsoPackages('/tmp/project', spawnSyncFn)).toBe(0);
        expect(spawnSyncFn).toHaveBeenCalledWith(
            'pnpm',
            expect.arrayContaining([
                '--filter=@magic-link-sso/config-core',
                '--filter=@magic-link-sso/angular',
                '--filter=@magic-link-sso/nextjs',
                '--filter=@magic-link-sso/nuxt',
            ]),
            { cwd: '/tmp/project', stdio: 'inherit' },
        );
        expect(buildDevSsoPackages('/tmp/project', () => ({ status: 7 }))).toBe(7);
        expect(() =>
            buildDevSsoPackages('/tmp/project', () => ({
                status: null,
                error: new Error('pnpm missing'),
            })),
        ).toThrow('pnpm missing');
    });

    const loginUis: ('hosted' | 'app-owned')[] = ['hosted', 'app-owned'];
    it.each(loginUis)(
        'generates valid matching issuer/Gate registrations for %s forms',
        async (loginUi): Promise<void> => {
            const root = await directory();
            const config = createDevSsoConfig(root, loginUi, inboxOptions);
            const path = join(root, 'issuer.toml');
            await writeFile(path, stringifyMagicSsoTomlConfig(config.issuer));
            const issuer = loadConfig({ MAGICSSO_CONFIG_FILE: path });
            expect(issuer.browserSso).toMatchObject({
                enabled: true,
                bootstrapEnabled: loginUi === 'app-owned',
                allowInsecureLocalhost: true,
            });
            expect(issuer.otp.enabled).toBe(true);
            expect(issuer.sites).toHaveLength(8);
            const origins = new Set(issuer.sites.flatMap((site) => [...site.origins]));
            expect(origins.size).toBe(8);
            expect(origins.has(issuer.appUrl)).toBe(false);
            for (const site of issuer.sites) {
                expect(site.launcher).toBeDefined();
                expect(site.accessRules.get('developer@example.com')).toEqual(new Set(['*']));
                expect(site.sso).toHaveLength(1);
            }
            for (const gate of config.gates) {
                const gatePath = join(root, `${gate.id}.toml`);
                await writeFile(gatePath, stringifyMagicSsoTomlConfig(gate.config));
                const parsed = loadGateConfig({ MAGIC_GATE_CONFIG_FILE: gatePath });
                expect(parsed.jwtSecret).toBe(issuer.jwtSecret);
                expect(parsed.browserSso).toMatchObject({ mode: 'required', loginUi });
                const site = issuer.sites.find((entry) => entry.id === gate.id);
                expect(site?.sso?.[0]).toEqual({
                    redirectUri: `${parsed.publicOrigin}${parsed.namespaceRoot}/sso/callback`,
                    startUri: `${parsed.publicOrigin}${parsed.namespaceRoot}/sso/start`,
                    signedOutUri: `${parsed.publicOrigin}${parsed.namespaceRoot}/signed-out`,
                });
            }
            expect(config.env.MAGICSSO_JWT_SECRET).toBe(issuer.jwtSecret);
            expect(config.env.MAGICSSO_COOKIE_DOMAIN).toBe('');
            expect(
                createDevSsoConfig(root, loginUi, inboxOptions).env.MAGICSSO_JWT_SECRET,
            ).not.toBe(issuer.jwtSecret);
        },
    );

    it('runs every real example on its own origin and does not source local env files', (): void => {
        const jobs = createDevSsoJobs('/tmp/shared-dev', true);
        for (const app of DEV_SSO_APPS) {
            const job = jobs.find((entry) => entry.id === app.id);
            expect(job).toBeDefined();
            if (!app.id.startsWith('private')) {
                expect(job?.env.MAGICSSO_PUBLIC_ORIGIN).toBe(devSsoOrigin(app));
                expect(job?.env.PORT).toBe(String(app.port));
            }
            expect(job?.args.join(' ')).not.toMatch(/ensure-env|server\/\.env/u);
        }
        expect(jobs.map((job) => job.id)).toEqual(
            expect.arrayContaining(['mail', 'issuer', 'upstream1', 'upstream2', 'photos']),
        );
        expect(jobs.find((job) => job.id === 'private2')?.env.MAGIC_GATE_CONFIG_FILE).toBe(
            '/tmp/shared-dev/private2.toml',
        );
        expect(jobs.find((job) => job.id === 'django')?.args).not.toContain('--noreload');
    });

    it('preserves legacy dev and includes every acceptance profile in test:e2e', async (): Promise<void> => {
        const root: { scripts: Record<string, string> } = JSON.parse(
            await readFile('package.json', 'utf8'),
        );
        const e2e: { scripts: Record<string, string> } = JSON.parse(
            await readFile('tests/e2e/package.json', 'utf8'),
        );
        expect(root.scripts.dev).toBe(
            'turbo run dev --filter=magic-sso-server --filter=example-app-angular --filter=example-app-django --filter=example-app-fastify --filter=example-app-nextjs --filter=example-app-nuxt',
        );
        expect(root.scripts['dev:sso:local']).toBe('node scripts/dev-sso.mjs --local');
        expect(root.scripts['dev:sso:app-owned']).toBe('pnpm dev:sso:local');
        for (const profile of Object.keys(e2e.scripts).filter(
            (name) =>
                name.startsWith('test:e2e:') && !['test:e2e:ui', 'test:e2e:headed'].includes(name),
        )) {
            expect(e2e.scripts['test:e2e']).toContain(`pnpm run ${profile}`);
        }
    });
});

describe('development process supervision', () => {
    function job(id: string, code: string): ReturnType<typeof createDevSsoJobs>[number] {
        return { id, cwd: '.', command: process.execPath, args: ['-e', code], env: {} };
    }

    it('stops sibling process groups and propagates an unexpected process exit', async (): Promise<void> => {
        const children: ChildProcess[] = [];
        vi.spyOn(console, 'error').mockImplementation(() => undefined);
        const result = await runDevSsoJobs(
            [job('long-running', 'setInterval(() => {}, 1000)'), job('failed', 'process.exit(7)')],
            {
                root: process.cwd(),
                env: process.env,
                signal: new AbortController().signal,
                spawnFn: (command, args, options) => {
                    const child = spawn(command, args, options);
                    children.push(child);
                    return child;
                },
            },
        );
        expect(result).toBe(1);
        expect(children[0]?.signalCode).toBe('SIGTERM');
        expect(children[1]?.exitCode).toBe(7);
    });

    it('shuts down cleanly on cancellation and does not start an already cancelled run', async (): Promise<void> => {
        const controller = new AbortController();
        const run = runDevSsoJobs([job('watcher', 'setInterval(() => {}, 1000)')], {
            root: process.cwd(),
            env: process.env,
            signal: controller.signal,
        });
        controller.abort();
        await expect(run).resolves.toBe(0);
        await expect(
            runDevSsoJobs([job('never-start', 'process.exit(1)')], {
                root: process.cwd(),
                env: process.env,
                signal: controller.signal,
            }),
        ).resolves.toBe(0);
    });

    it('accepts macOS EPERM when cleaning an already exited process group', async (): Promise<void> => {
        const originalKill = process.kill.bind(process);
        vi.spyOn(process, 'kill').mockImplementation((pid, signal) => {
            if (pid < 0 && signal === 'SIGKILL') {
                throw Object.assign(new Error('Exited process group'), { code: 'EPERM' });
            }
            return originalKill(pid, signal);
        });
        const controller = new AbortController();
        const run = runDevSsoJobs([job('watcher', 'setInterval(() => {}, 1000)')], {
            root: process.cwd(),
            env: process.env,
            signal: controller.signal,
        });
        controller.abort();
        await expect(run).resolves.toBe(0);
    });

    it('shuts down siblings when a process cannot start', async (): Promise<void> => {
        vi.spyOn(console, 'error').mockImplementation(() => undefined);
        const missing = { ...job('missing', ''), command: '/nonexistent/magic-sso-dev-command' };
        await expect(
            runDevSsoJobs([job('watcher', 'setInterval(() => {}, 1000)'), missing], {
                root: process.cwd(),
                env: process.env,
                signal: new AbortController().signal,
            }),
        ).resolves.toBe(1);
    });

    it.each([false, true])(
        'removes private generated configuration after shutdown or failure (%s)',
        async (fail): Promise<void> => {
            let configFile = '';
            vi.spyOn(console, 'log').mockImplementation(() => undefined);
            const run = runSsoDev({
                loginUi: 'app-owned',
                ...inboxOptions,
                signal: new AbortController().signal,
                buildFn: () => 0,
                runJobsFn: async (jobs, options): Promise<number> => {
                    configFile =
                        jobs.find((entry) => entry.id === 'issuer')?.env.MAGICSSO_CONFIG_FILE ?? '';
                    expect((await stat(configFile)).mode & 0o777).toBe(0o600);
                    const issuer = loadConfig({ MAGICSSO_CONFIG_FILE: configFile });
                    expect(issuer.jwtSecret).toBe(options.env.MAGICSSO_JWT_SECRET);
                    expect(issuer.browserSso?.bootstrapEnabled).toBe(true);
                    if (fail) {
                        throw new Error('startup failed');
                    }
                    return 0;
                },
            });
            if (fail) {
                await expect(run).rejects.toThrow('startup failed');
            } else {
                await expect(run).resolves.toBe(0);
            }
            await expect(stat(configFile)).rejects.toThrow();
        },
    );

    it('does not launch services when building framework packages fails', async (): Promise<void> => {
        const runJobsFn = vi.fn();
        await expect(
            runSsoDev({
                loginUi: 'hosted',
                signal: new AbortController().signal,
                buildFn: () => 7,
                runJobsFn,
            }),
        ).resolves.toBe(7);
        expect(runJobsFn).not.toHaveBeenCalled();
    });
});
