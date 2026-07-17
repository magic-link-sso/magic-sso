import { spawn, spawnSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const scriptDirectory = dirname(fileURLToPath(import.meta.url));
const repositoryRoot = resolve(scriptDirectory, '..');

/**
 * @typedef {{
 *   parseMagicSsoTomlConfig(fileContents: string, filePath: string): Record<string, unknown>;
 *   stringifyMagicSsoTomlConfig(config: Record<string, unknown>): string;
 * }} ConfigCoreModule
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
 *   env: NodeJS.ProcessEnv;
 *   on(event: NodeJS.Signals, listener: () => void): unknown;
 *   removeListener(event: NodeJS.Signals, listener: () => void): unknown;
 * }} ProcessLike
 */

/**
 * @typedef {{
 *   direct?: boolean;
 *   processObject?: ProcessLike;
 *   repositoryRoot?: string;
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
 *   loadConfigCore?: () => Promise<ConfigCoreModule>;
 * }} RunOtpDevOptions
 */

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
        if (key.length > 0) {
            values[key] = value;
        }
    }

    return values;
}

/**
 * @param {NodeJS.ProcessEnv} env
 * @param {string} root
 * @returns {string}
 */
export function resolveSourceConfigPath(env, root = repositoryRoot) {
    const serverDirectory = join(root, 'server');
    const envConfigPath = env.MAGICSSO_CONFIG_FILE;
    const configuredPath =
        envConfigPath ??
        parseEnvFile(readFileSync(join(serverDirectory, '.env'), 'utf8')).MAGICSSO_CONFIG_FILE;

    if (typeof configuredPath !== 'string' || configuredPath.length === 0) {
        throw new Error('MAGICSSO_CONFIG_FILE must be set in the environment or server/.env.');
    }

    return resolve(serverDirectory, configuredPath);
}

/**
 * @param {Record<string, unknown>} config
 * @param {string} secret
 * @returns {Record<string, unknown>}
 */
export function enableDevOtp(config, secret) {
    const auth = config.auth;
    if (typeof auth !== 'object' || auth === null || Array.isArray(auth)) {
        throw new Error('Expected an auth table in the Magic Link SSO config.');
    }

    return {
        ...config,
        auth: {
            ...auth,
            otp: {
                allowedAttempts: 3,
                enabled: true,
                expiration: '5m',
                length: 6,
                resendStrategy: 'rotate',
                secret,
            },
        },
    };
}

/**
 * @param {string} root
 * @returns {Promise<ConfigCoreModule>}
 */
async function loadBuiltConfigCore(root) {
    const configCoreUrl = pathToFileURL(join(root, 'packages/config-core/dist/index.js')).href;
    return import(configCoreUrl);
}

/**
 * @param {(
 *   command: string,
 *   args: string[],
 *   options: { cwd: string; env: NodeJS.ProcessEnv; stdio: 'inherit' },
 * ) => SyncResult} spawnSyncFn
 * @param {NodeJS.ProcessEnv} env
 * @param {string} root
 * @returns {void}
 */
function buildConfigCore(spawnSyncFn, env, root) {
    const result = spawnSyncFn('pnpm', ['--filter', '@magic-link-sso/config-core', 'build'], {
        cwd: root,
        env,
        stdio: 'inherit',
    });
    if (result.error instanceof Error) {
        throw result.error;
    }
    if (result.status !== 0 || result.signal !== null) {
        throw new Error(
            'Failed to build @magic-link-sso/config-core for the OTP development config.',
        );
    }
}

/**
 * @param {RunOtpDevOptions} [options]
 * @returns {Promise<number>}
 */
export async function runOtpDev(options = {}) {
    const root = options.repositoryRoot ?? repositoryRoot;
    const processObject = options.processObject ?? process;
    const spawnFn = options.spawnFn ?? spawn;
    const spawnSyncFn = options.spawnSyncFn ?? spawnSync;
    const sourceConfigPath = resolveSourceConfigPath(processObject.env, root);
    const temporaryDirectory = mkdtempSync(join(tmpdir(), 'magic-sso-dev-otp-'));
    const temporaryConfigPath = join(
        temporaryDirectory,
        `${basename(sourceConfigPath, '.toml')}.otp.toml`,
    );

    try {
        buildConfigCore(spawnSyncFn, processObject.env, root);
        const configCore = await (options.loadConfigCore ?? (() => loadBuiltConfigCore(root)))();
        const sourceConfig = configCore.parseMagicSsoTomlConfig(
            readFileSync(sourceConfigPath, 'utf8'),
            sourceConfigPath,
        );
        const otpSecret =
            processObject.env.MAGICSSO_DEV_OTP_SECRET ?? randomBytes(32).toString('base64url');
        writeFileSync(
            temporaryConfigPath,
            configCore.stringifyMagicSsoTomlConfig(enableDevOtp(sourceConfig, otpSecret)),
            'utf8',
        );

        const env = {
            ...processObject.env,
            MAGICSSO_CONFIG_FILE: temporaryConfigPath,
            ...(options.direct ? { MAGICSSO_DIRECT_USE: 'true' } : {}),
        };
        const child = spawnFn('pnpm', ['dev'], { cwd: root, env, stdio: 'inherit' });

        return await new Promise((resolvePromise, reject) => {
            let settled = false;
            const cleanup = () => {
                processObject.removeListener('SIGINT', forwardSigint);
                processObject.removeListener('SIGTERM', forwardSigterm);
                rmSync(temporaryDirectory, { force: true, recursive: true });
            };
            const settle = (callback) => {
                if (settled) {
                    return;
                }
                settled = true;
                cleanup();
                callback();
            };
            const forwardSigint = () => {
                child.kill('SIGINT');
            };
            const forwardSigterm = () => {
                child.kill('SIGTERM');
            };

            processObject.on('SIGINT', forwardSigint);
            processObject.on('SIGTERM', forwardSigterm);
            child.once('error', (error) => {
                settle(() => reject(error));
            });
            child.once('exit', (code, signal) => {
                settle(() => {
                    resolvePromise(signal === 'SIGINT' || signal === 'SIGTERM' ? 0 : (code ?? 1));
                });
            });
        });
    } catch (error) {
        rmSync(temporaryDirectory, { force: true, recursive: true });
        throw error;
    }
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
    const direct = process.argv.slice(2).includes('--direct');
    const exitCode = await runOtpDev({ direct });
    process.exitCode = exitCode;
}
