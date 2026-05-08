import { spawn, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const scriptDirectory = dirname(fileURLToPath(import.meta.url));
const repositoryRoot = resolve(scriptDirectory, '..');
const DEFAULT_MANAGER_AUDIT_INTEGRITY_KEY = 'manager-dev-audit-integrity-key-1234567890';

/**
 * @typedef {{
 *   cwd?: string;
 *   env: NodeJS.ProcessEnv;
 *   on(event: NodeJS.Signals, listener: () => void): unknown;
 *   removeListener(event: NodeJS.Signals, listener: () => void): unknown;
 * }} ProcessLike
 */

/**
 * @typedef {{
 *   error?: Error;
 *   signal: NodeJS.Signals | null;
 *   status: number | null;
 * }} SyncResult
 */

/**
 * @typedef {{
 *   kill(signal?: NodeJS.Signals): boolean;
 *   once(event: 'error', listener: (error: Error) => void): unknown;
 *   once(event: 'exit', listener: (code: number | null, signal: NodeJS.Signals | null) => void): unknown;
 * }} ChildLike
 */

/**
 * @typedef {{
 *   processObject?: ProcessLike;
 *   spawnFn?: (
 *     command: string,
 *     args: string[],
 *     options: { cwd: string; env: NodeJS.ProcessEnv; stdio: 'inherit' },
 *   ) => ChildLike;
 *   spawnSyncFn?: (
 *     command: string,
 *     args: string[],
 *     options: { cwd: string; env: NodeJS.ProcessEnv; stdio: 'inherit' },
 *   ) => SyncResult;
 *   repositoryRoot?: string;
 * }} RunManagerDevOptions
 */

/**
 * @typedef {{
 *   gateConfigFilePath: string;
 *   managerConfigFilePath: string;
 *   managerDirectory: string;
 *   managerEnvExampleFilePath: string;
 *   managerEnvFilePath: string;
 *   managerRuntimeDirectory: string;
 *   managerStateFilePath: string;
 *   managerStateTemplatePath: string;
 *   rootComposeFilePath: string;
 * }} ManagerDevPaths
 */

/**
 * @param {string | null} value
 * @returns {number}
 */
function resolveExitCode(value) {
    return value === null ? 1 : value;
}

/**
 * @param {number | null} code
 * @param {NodeJS.Signals | null} signal
 * @returns {number}
 */
function normalizeExitCode(code, signal) {
    return signal === 'SIGINT' || signal === 'SIGTERM' || code === 130 || code === 143
        ? 0
        : (code ?? 1);
}

/**
 * @param {string} template
 * @param {NodeJS.ProcessEnv} env
 * @returns {string}
 */
function renderTemplate(template, env) {
    return template.replaceAll(/\$\{([A-Z0-9_]+)\}/g, (_match, key) => {
        const value = env[key];
        if (typeof value !== 'string' || value.length === 0) {
            throw new Error(`Missing required env var for manager dev stack: ${key}`);
        }

        return value;
    });
}

/**
 * @param {string} fileContents
 * @returns {Record<string, string>}
 */
export function parseEnvFile(fileContents) {
    /** @type {Record<string, string>} */
    const values = {};

    for (const rawLine of fileContents.split(/\r?\n/u)) {
        const line = rawLine.trim();
        if (line.length === 0 || line.startsWith('#')) {
            continue;
        }

        const separatorIndex = line.indexOf('=');
        if (separatorIndex === -1) {
            continue;
        }

        const key = line.slice(0, separatorIndex).trim();
        const value = line.slice(separatorIndex + 1).trim();
        if (key.length === 0) {
            continue;
        }

        values[key] = value;
    }

    return values;
}

/**
 * @param {string} root
 * @returns {ManagerDevPaths}
 */
export function resolveManagerDevPaths(root = repositoryRoot) {
    const managerDirectory = join(root, 'manager');
    const managerRuntimeDirectory = join(managerDirectory, 'runtime');

    return {
        gateConfigFilePath: join(managerRuntimeDirectory, 'magic-gate.toml'),
        managerConfigFilePath: join(managerRuntimeDirectory, 'manager.toml'),
        managerDirectory,
        managerEnvFilePath: join(managerDirectory, '.env'),
        managerEnvExampleFilePath: join(managerDirectory, '.env.example'),
        managerRuntimeDirectory,
        managerStateFilePath: join(managerRuntimeDirectory, 'manager-state.json'),
        managerStateTemplatePath: join(managerDirectory, 'dev', 'manager-state.json.template'),
        rootComposeFilePath: join(managerDirectory, 'docker-compose.yml'),
    };
}

/**
 * @param {NodeJS.ProcessEnv} env
 * @param {string} root
 * @returns {NodeJS.ProcessEnv}
 */
export function buildManagerDevEnvironment(env, root = repositoryRoot) {
    const paths = resolveManagerDevPaths(root);
    const envFilePath = existsSync(paths.managerEnvFilePath)
        ? paths.managerEnvFilePath
        : paths.managerEnvExampleFilePath;
    const envFileValues = existsSync(envFilePath)
        ? parseEnvFile(readFileSync(envFilePath, 'utf8'))
        : {};
    const mergedEnv = {
        ...envFileValues,
        ...env,
    };
    const managerPublicPort = mergedEnv.MANAGER_PUBLIC_PORT ?? '4306';
    const managerUpstreamPort = mergedEnv.MANAGER_UPSTREAM_PORT ?? '4311';
    const serverOrigin = mergedEnv.MANAGER_DEV_SERVER_ORIGIN ?? 'http://127.0.0.1:3000';
    const publicOrigin =
        mergedEnv.MANAGER_DEV_PUBLIC_ORIGIN ?? `http://localhost:${managerPublicPort}`;
    const gateUpstreamOrigin =
        mergedEnv.MANAGER_DEV_GATE_UPSTREAM_ORIGIN ?? `http://127.0.0.1:${managerUpstreamPort}`;
    const mailpitSmtpPort = mergedEnv.MAILPIT_SMTP_PORT ?? '1025';
    const photosOrigin = mergedEnv.MANAGER_DEV_PHOTOS_ORIGIN ?? 'http://localhost:5001';
    const photosOwnerEmail = mergedEnv.PHOTOS_OWNER_EMAIL ?? 'owner@example.com';
    const photosFriendEmail = mergedEnv.PHOTOS_FRIEND_EMAIL ?? 'friend@example.com';
    const photosFamilyEmail = mergedEnv.PHOTOS_FAMILY_EMAIL ?? 'family@example.com';

    return {
        ...mergedEnv,
        MAGIC_GATE_RENDER_COOKIE_MAX_AGE: mergedEnv.MAGICSSO_COOKIE_MAX_AGE ?? '3600',
        MAGIC_GATE_RENDER_COOKIE_NAME: mergedEnv.MAGICSSO_COOKIE_NAME ?? 'magic-sso',
        MAGIC_GATE_RENDER_DIRECT_USE: 'false',
        MAGIC_GATE_RENDER_JWT_SECRET: mergedEnv.MAGICSSO_JWT_SECRET,
        MAGIC_GATE_RENDER_MODE: 'subdomain',
        MAGIC_GATE_RENDER_NAMESPACE: '/_magicgate',
        MAGIC_GATE_RENDER_PREVIEW_SECRET: mergedEnv.MAGICSSO_PREVIEW_SECRET,
        MAGIC_GATE_RENDER_PUBLIC_ORIGIN: publicOrigin,
        MAGIC_GATE_RENDER_RATE_LIMIT_MAX: '240',
        MAGIC_GATE_RENDER_RATE_LIMIT_WINDOW_MS: '60000',
        MAGIC_GATE_RENDER_REQUEST_TIMEOUT_MS: '10000',
        MAGIC_GATE_RENDER_SERVER_URL: serverOrigin,
        MAGIC_GATE_RENDER_TRUST_PROXY: 'false',
        MAGIC_GATE_RENDER_UPSTREAM_URL: gateUpstreamOrigin,
        MAGIC_GATE_RENDER_WS_ENABLED: 'true',
        MAGICSSO_CONFIG_FILE: join(paths.managerRuntimeDirectory, 'magic-sso.runtime.toml'),
        MAGICSSO_MANAGER_CONFIG_FILE: paths.managerConfigFilePath,
        MAILPIT_SMTP_PORT: mailpitSmtpPort,
        MANAGER_DEV_PUBLIC_ORIGIN: publicOrigin,
        MANAGER_DEV_PHOTOS_ORIGIN: photosOrigin,
        MANAGER_DEV_SERVER_ORIGIN: serverOrigin,
        MANAGER_DEV_SMTP_HOST: mergedEnv.MANAGER_DEV_SMTP_HOST ?? '127.0.0.1',
        MANAGER_AUDIT_INTEGRITY_KEY:
            mergedEnv.MANAGER_AUDIT_INTEGRITY_KEY ?? DEFAULT_MANAGER_AUDIT_INTEGRITY_KEY,
        MANAGER_DEV_GATE_UPSTREAM_ORIGIN: gateUpstreamOrigin,
        MANAGER_PUBLIC_PORT: managerPublicPort,
        MANAGER_UPSTREAM_PORT: managerUpstreamPort,
        PHOTOS_FAMILY_EMAIL: photosFamilyEmail,
        PHOTOS_FRIEND_EMAIL: photosFriendEmail,
        PHOTOS_OWNER_EMAIL: photosOwnerEmail,
    };
}

/**
 * @param {ManagerDevPaths} paths
 * @param {NodeJS.ProcessEnv} env
 * @returns {{ gateConfigFilePath: string; managerConfigFilePath: string }}
 */
export function renderManagerDevFiles(paths, env) {
    mkdirSync(paths.managerRuntimeDirectory, { recursive: true });

    const filesToRender = [
        {
            outputPath: join(paths.managerRuntimeDirectory, 'magic-sso.base.toml'),
            templatePath: join(paths.managerDirectory, 'dev', 'magic-sso.base.local.toml.template'),
        },
        {
            outputPath: paths.managerConfigFilePath,
            templatePath: join(paths.managerDirectory, 'dev', 'manager.local.toml.template'),
        },
        {
            outputPath: paths.gateConfigFilePath,
            templatePath: join(paths.managerDirectory, 'dev', 'magic-gate.local.toml.template'),
        },
    ];

    for (const file of filesToRender) {
        const template = readFileSync(file.templatePath, 'utf8');
        writeFileSync(file.outputPath, renderTemplate(template, env), 'utf8');
    }

    if (!existsSync(paths.managerStateFilePath)) {
        const managerStateTemplate = readFileSync(paths.managerStateTemplatePath, 'utf8');
        writeFileSync(
            paths.managerStateFilePath,
            renderTemplate(managerStateTemplate, env),
            'utf8',
        );
    }

    return {
        gateConfigFilePath: paths.gateConfigFilePath,
        managerConfigFilePath: paths.managerConfigFilePath,
    };
}

/**
 * @param {(
 *     command: string,
 *     args: string[],
 *     options: { cwd: string; env: NodeJS.ProcessEnv; stdio: 'inherit' },
 * ) => SyncResult} spawnSyncFn
 * @param {string} command
 * @param {string[]} args
 * @param {{ cwd: string; env: NodeJS.ProcessEnv; stdio: 'inherit' }} options
 * @returns {number}
 */
function runSyncOrThrow(spawnSyncFn, command, args, options) {
    const result = spawnSyncFn(command, args, options);
    if (result.error instanceof Error) {
        throw result.error;
    }

    if (result.status !== 0 || result.signal !== null) {
        return normalizeExitCode(result.status, result.signal);
    }

    return 0;
}

/**
 * @param {RunManagerDevOptions} [options]
 * @returns {Promise<number>}
 */
export async function runManagerDevStack(options = {}) {
    const root = options.repositoryRoot ?? repositoryRoot;
    const processObject = options.processObject ?? process;
    const spawnFn = options.spawnFn ?? spawn;
    const spawnSyncFn = options.spawnSyncFn ?? spawnSync;
    const paths = resolveManagerDevPaths(root);
    const env = buildManagerDevEnvironment(processObject.env, root);
    const managerEnvFilePath = existsSync(paths.managerEnvFilePath)
        ? paths.managerEnvFilePath
        : paths.managerEnvExampleFilePath;

    renderManagerDevFiles(paths, env);

    if (env.MANAGER_SKIP_MAILPIT !== '1') {
        const mailpitExitCode = runSyncOrThrow(
            spawnSyncFn,
            'docker',
            [
                'compose',
                '--env-file',
                managerEnvFilePath,
                '-f',
                paths.rootComposeFilePath,
                'up',
                '-d',
                'mailpit',
            ],
            {
                cwd: root,
                env,
                stdio: 'inherit',
            },
        );

        if (mailpitExitCode !== 0) {
            return mailpitExitCode;
        }
    }

    for (const command of [
        ['pnpm', ['--filter', '@magic-link-sso/config-core', 'build']],
        ['pnpm', ['--filter', 'magic-sso-manager', 'build']],
        ['node', ['manager/dev/bootstrap-local-managed-stack.mjs']],
    ]) {
        const exitCode = runSyncOrThrow(spawnSyncFn, command[0], command[1], {
            cwd: root,
            env,
            stdio: 'inherit',
        });

        if (exitCode !== 0) {
            return exitCode;
        }
    }

    const childSpecs = [
        {
            args: ['--filter', '@magic-link-sso/config-core', 'build:watch'],
            command: 'pnpm',
            env,
            label: 'config-core',
        },
        {
            args: ['--filter', 'magic-sso-server', 'dev'],
            command: 'pnpm',
            env,
            label: 'server',
        },
        {
            args: ['--filter', 'example-app-photos', 'dev'],
            command: 'pnpm',
            env: {
                ...env,
                MAGICSSO_COOKIE_MAX_AGE: env.MAGICSSO_COOKIE_MAX_AGE ?? '3600',
                MAGICSSO_DIRECT_USE: 'false',
                MAGICSSO_JWT_SECRET: env.MAGICSSO_JWT_SECRET,
                MAGICSSO_PREVIEW_SECRET: env.MAGICSSO_PREVIEW_SECRET,
                MAGICSSO_PUBLIC_ORIGIN: env.MANAGER_DEV_PHOTOS_ORIGIN,
                MAGICSSO_SERVER_URL: env.MANAGER_DEV_SERVER_ORIGIN,
            },
            label: 'photos',
        },
        {
            args: ['--filter', 'magic-sso-manager', 'dev'],
            command: 'pnpm',
            env,
            label: 'manager',
        },
        {
            args: ['--filter', 'magic-sso-gate', 'dev'],
            command: 'pnpm',
            env: {
                ...env,
                MAGIC_GATE_CONFIG_FILE: paths.gateConfigFilePath,
            },
            label: 'gate',
        },
    ];

    /** @type {Array<{ child: ChildLike; label: string }>} */
    const children = childSpecs.map((spec) => ({
        child: spawnFn(spec.command, spec.args, {
            cwd: root,
            env: spec.env,
            stdio: 'inherit',
        }),
        label: spec.label,
    }));

    return new Promise((resolve, reject) => {
        let settled = false;

        const stopAll = (signal) => {
            for (const entry of children) {
                entry.child.kill(signal);
            }
        };

        const forwardSigint = () => {
            stopAll('SIGINT');
        };
        const forwardSigterm = () => {
            stopAll('SIGTERM');
        };
        const cleanup = () => {
            processObject.removeListener('SIGINT', forwardSigint);
            processObject.removeListener('SIGTERM', forwardSigterm);
        };
        const settle = (callback) => {
            if (settled) {
                return;
            }

            settled = true;
            cleanup();
            callback();
        };

        processObject.on('SIGINT', forwardSigint);
        processObject.on('SIGTERM', forwardSigterm);

        for (const entry of children) {
            entry.child.once('error', (error) => {
                settle(() => {
                    stopAll('SIGTERM');
                    reject(error);
                });
            });

            entry.child.once('exit', (code, signal) => {
                settle(() => {
                    stopAll(signal === null ? 'SIGTERM' : signal);
                    resolve(normalizeExitCode(code, signal));
                });
            });
        }
    });
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
    const exitCode = await runManagerDevStack();
    process.exitCode = resolveExitCode(exitCode);
}
