// SPDX-License-Identifier: MIT

import { spawnSync } from 'node:child_process';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

/** @param {string} path @returns {string} */
function resolveNonempty(path) {
    return path.trim() ? resolve(path) : path;
}

const [component, ...args] = process.argv.slice(2);
if (!['server', 'manager'].includes(component)) {
    const help = component === '--help';
    (help ? process.stdout : process.stderr).write(
        'Usage: pnpm doctor server|manager [--config <file>] [--json] [--online] [--timeout-ms <100..30000>] [--help]\nServer only: --send-test-email <address>\n',
    );
    process.exitCode = help ? 0 : 2;
} else {
    const cwd = resolve(dirname(fileURLToPath(import.meta.url)), '..', component);
    const env = { ...process.env };
    const configKey =
        component === 'server' ? 'MAGICSSO_CONFIG_FILE' : 'MAGICSSO_MANAGER_CONFIG_FILE';
    if (env[configKey]) {
        env[configKey] = resolve(env[configKey]);
    }
    const forwarded = args.map((value, index) => {
        if (args[index - 1] === '--config') {
            return resolveNonempty(value);
        }
        if (value.startsWith('--config=')) {
            const path = value.slice('--config='.length);
            return `--config=${resolveNonempty(path)}`;
        }
        return value;
    });
    // Build logs belong on stderr so --json stdout remains a single report.
    const build = spawnSync('pnpm', ['build'], { cwd, env, stdio: ['inherit', 2, 2] });
    if (build.status !== 0) {
        process.exitCode = build.status ?? 1;
    } else {
        const entry = component === 'server' ? ['dist/doctor.js'] : ['dist/cli.js', 'doctor'];
        const result = spawnSync(process.execPath, [...entry, ...forwarded], {
            cwd,
            env,
            stdio: 'inherit',
        });
        process.exitCode = result.status ?? 1;
    }
}
