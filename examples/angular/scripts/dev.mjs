// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Wojciech Polak

import { spawn, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

/**
 * @typedef {{
 *   error?: Error;
 *   signal: NodeJS.Signals | null;
 *   status: number | null;
 * }} SyncResult
 */

/**
 * @typedef {{
 *   env: NodeJS.ProcessEnv;
 *   on(event: NodeJS.Signals, listener: () => void): NodeJS.Process;
 *   removeListener(event: NodeJS.Signals, listener: () => void): NodeJS.Process;
 * }} ProcessLike
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
 *   spawnFn?: (command: string, args: string[], options: { env: NodeJS.ProcessEnv; stdio: 'inherit' }) => ChildLike;
 *   spawnSyncFn?: (
 *       command: string,
 *       args: string[],
 *       options: { env: NodeJS.ProcessEnv; stdio: 'inherit' },
 *   ) => SyncResult;
 * }} RunDevOptions
 */

/**
 * @param {number | null} code
 * @param {NodeJS.Signals | null} signal
 * @returns {number}
 */
function resolveExitCode(code, signal) {
    return signal === 'SIGINT' || signal === 'SIGTERM' || code === 130 || code === 143
        ? 0
        : (code ?? 1);
}

/**
 * @param {RunDevOptions} [options]
 * @returns {Promise<number>}
 */
export async function runDev(options = {}) {
    const processObject = options.processObject ?? process;
    const spawnFn = options.spawnFn ?? spawn;
    const spawnSyncFn = options.spawnSyncFn ?? spawnSync;
    const env = processObject.env;
    const buildResult = spawnSyncFn('pnpm', ['--filter', '@magic-link-sso/angular', 'build'], {
        env,
        stdio: 'inherit',
    });

    if (buildResult.error instanceof Error) {
        throw buildResult.error;
    }

    if (buildResult.status !== 0 || buildResult.signal !== null) {
        return resolveExitCode(buildResult.status, buildResult.signal);
    }

    const child = spawnFn('ng', ['serve', '--host', '0.0.0.0', '--port', '3004'], {
        env,
        stdio: 'inherit',
    });

    return new Promise((resolve, reject) => {
        const forwardSigint = () => {
            child.kill('SIGINT');
        };
        const forwardSigterm = () => {
            child.kill('SIGTERM');
        };
        const cleanup = () => {
            processObject.removeListener('SIGINT', forwardSigint);
            processObject.removeListener('SIGTERM', forwardSigterm);
        };

        processObject.on('SIGINT', forwardSigint);
        processObject.on('SIGTERM', forwardSigterm);

        child.once('error', (error) => {
            cleanup();
            reject(error);
        });
        child.once('exit', (code, signal) => {
            cleanup();
            resolve(resolveExitCode(code, signal));
        });
    });
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
    const exitCode = await runDev();
    process.exitCode = exitCode;
}
