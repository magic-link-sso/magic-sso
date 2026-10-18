// SPDX-License-Identifier: MIT
import { spawn, spawnSync } from 'node:child_process';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
    createDevSsoConfig,
    createDevSsoJobs,
    DEV_SSO_APPS,
    DEV_SSO_ISSUER,
    DEV_SSO_INBOX,
    devSsoOrigin,
} from './dev-sso-config.mjs';
import { resolveSourceConfigPath } from './dev-otp.mjs';

const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');

/** @param {import('node:child_process').ChildProcess} child @param {NodeJS.Signals} signal @returns {void} */
function stopChild(child, signal) {
    try {
        if (child.pid && process.platform !== 'win32') {
            process.kill(-child.pid, signal);
        } else if (child.exitCode === null && child.signalCode === null) {
            child.kill(signal);
        }
    } catch (error) {
        if (error instanceof Error && 'code' in error) {
            const exited = child.exitCode !== null || child.signalCode !== null;
            // macOS can report EPERM for the group of an already exited wrapper.
            if (error.code === 'ESRCH' || (error.code === 'EPERM' && exited)) {
                return;
            }
        }
        throw error;
    }
}

/**
 * Stop entire process groups, including watchers, before deleting their configuration.
 * @param {ReturnType<typeof createDevSsoJobs>} jobs
 * @param {{root: string; env: NodeJS.ProcessEnv; signal: AbortSignal; spawnFn?: typeof spawn}} options
 * @returns {Promise<number>}
 */
export async function runDevSsoJobs(jobs, options) {
    if (options.signal.aborted) {
        return 0;
    }
    const children = [];
    let stopping = false;
    let exitCode = 0;
    /** @type {ReturnType<typeof setTimeout> | undefined} */
    let timer;
    const stop = () => {
        if (stopping) {
            return;
        }
        stopping = true;
        for (const child of children) {
            stopChild(child, 'SIGTERM');
        }
        timer = setTimeout(() => {
            for (const child of children) {
                stopChild(child, 'SIGKILL');
            }
        }, 5000);
        timer.unref();
    };
    options.signal.addEventListener('abort', stop, { once: true });
    try {
        const finished = jobs.map(
            (job) =>
                new Promise((done) => {
                    const child = (options.spawnFn ?? spawn)(job.command, job.args, {
                        cwd: join(options.root, job.cwd),
                        env: { ...options.env, ...job.env },
                        stdio: 'inherit',
                        detached: process.platform !== 'win32',
                    });
                    children.push(child);
                    const fail = () => {
                        if (!stopping) {
                            console.error(
                                `Magic Link SSO dev: ${job.id} stopped; shutting down the stack.`,
                            );
                            exitCode = 1;
                            stop();
                        }
                    };
                    child.once('error', fail);
                    child.once('close', () => {
                        fail();
                        done();
                    });
                }),
        );
        await Promise.all(finished);
        return exitCode;
    } finally {
        options.signal.removeEventListener('abort', stop);
        stop();
        // A wrapper can exit before its watcher. Kill remaining group members too.
        for (const child of children) {
            stopChild(child, 'SIGKILL');
        }
        clearTimeout(timer);
    }
}

/**
 * @param {string} root
 * @param {(command: string, args: string[], options: {cwd: string; stdio: 'inherit'}) => {status: number | null; error?: Error}} [spawnSyncFn]
 * @returns {number}
 */
export function buildDevSsoPackages(root, spawnSyncFn = spawnSync) {
    const build = spawnSyncFn(
        'pnpm',
        [
            'exec',
            'turbo',
            'run',
            'build',
            '--filter=@magic-link-sso/config-core',
            '--filter=@magic-link-sso/angular',
            '--filter=@magic-link-sso/nextjs',
            '--filter=@magic-link-sso/nuxt',
        ],
        { cwd: root, stdio: 'inherit' },
    );
    if (build.error) {
        throw build.error;
    }
    return build.status ?? 1;
}

/**
 * @param {{loginUi: 'hosted' | 'app-owned'; signal: AbortSignal; root?: string; email?: string; inbox?: boolean; env?: NodeJS.ProcessEnv; buildFn?: (root: string) => number; runJobsFn?: typeof runDevSsoJobs}} options
 * @returns {Promise<number>}
 */
export async function runSsoDev(options) {
    if (options.signal.aborted) {
        return 0;
    }
    const root = options.root ?? repositoryRoot;
    const status = (options.buildFn ?? buildDevSsoPackages)(root);
    if (options.signal.aborted) {
        return 0;
    }
    if (status !== 0) {
        return status;
    }
    const directory = await mkdtemp(join(tmpdir(), 'magic-sso-dev-shared-'));
    try {
        const { stringifyMagicSsoTomlConfig, parseMagicSsoTomlConfig } =
            await import('../packages/config-core/dist/index.js');
        const env = options.env ?? process.env;
        const sourcePath =
            options.inbox && options.email ? undefined : resolveSourceConfigPath(env, root);
        const source =
            sourcePath === undefined
                ? undefined
                : parseMagicSsoTomlConfig(await readFile(sourcePath, 'utf8'), sourcePath);
        const config = createDevSsoConfig(directory, options.loginUi, {
            source,
            email: options.email,
            inbox: options.inbox,
        });
        for (const { id, config: value } of [
            { id: 'issuer', config: config.issuer },
            ...config.gates,
        ]) {
            await writeFile(join(directory, `${id}.toml`), stringifyMagicSsoTomlConfig(value), {
                mode: 0o600,
            });
        }
        console.log(
            `\nMagic Link SSO — ${options.loginUi === 'hosted' ? 'central form' : 'local application forms'} + OTP`,
        );
        console.log(`Launcher: ${DEV_SSO_ISSUER}/sso/apps`);
        console.log(
            options.inbox
                ? `Email links and OTP: ${DEV_SSO_INBOX}`
                : `Email delivery and access rules: ${sourcePath}`,
        );
        console.log(
            options.email
                ? `Full access to all examples: ${options.email}`
                : 'Use an email allowed in your server config. Add --email you@example.com for full access to all examples.',
        );
        for (const app of DEV_SSO_APPS) {
            console.log(`${app.name}: ${devSsoOrigin(app)}${app.path}`);
        }
        return await (options.runJobsFn ?? runDevSsoJobs)(
            createDevSsoJobs(directory, options.inbox),
            {
                root,
                env: { ...env, ...config.env },
                signal: options.signal,
            },
        );
    } finally {
        await rm(directory, { recursive: true, force: true });
    }
}

/** @param {string[]} args @returns {{loginUi: 'hosted' | 'app-owned'; email?: string; inbox?: boolean}} */
export function parseDevSsoArgs(args) {
    /** @type {{loginUi: 'hosted' | 'app-owned'; email?: string; inbox?: boolean}} */
    const options = { loginUi: 'hosted' };
    for (let index = 0; index < args.length; index += 1) {
        switch (args[index]) {
            case '--local':
                options.loginUi = 'app-owned';
                break;
            case '--inbox':
                options.inbox = true;
                break;
            case '--email': {
                const email = args[++index]?.trim().toLowerCase();
                if (!email || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/u.test(email)) {
                    throw new Error('--email needs a valid email address.');
                }
                options.email = email;
                break;
            }
            default:
                throw new Error(
                    'Usage: pnpm dev:sso [--local] [--email you@example.com] [--inbox]',
                );
        }
    }
    return options;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
    const options = parseDevSsoArgs(process.argv.slice(2));
    const controller = new AbortController();
    const stop = () => controller.abort();
    process.on('SIGINT', stop);
    process.on('SIGTERM', stop);
    try {
        process.exitCode = await runSsoDev({
            ...options,
            signal: controller.signal,
        });
    } finally {
        process.removeListener('SIGINT', stop);
        process.removeListener('SIGTERM', stop);
    }
}
