import { execFileSync } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import path from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';

const repositoryRoot = path.resolve(fileURLToPath(new URL('..', import.meta.url)));
const uvEnvironment = {
    ...process.env,
    UV_CACHE_DIR: '/tmp/uv-cache',
    UV_TOOL_DIR: '/tmp/uv-tools',
    UV_STATE_DIR: '/tmp/uv-state',
};

/**
 * Build the commands used by the Python dependency audit.
 *
 * @param {string} requirementsFile
 * @returns {{ exportArgs: string[]; auditArgs: string[] }}
 */
export function buildAuditArgs(requirementsFile) {
    return {
        exportArgs: [
            'export',
            '--project',
            path.join(repositoryRoot, 'packages/django'),
            '--locked',
            '--no-dev',
            '--no-emit-project',
            '--format',
            'requirements.txt',
            '--output-file',
            requirementsFile,
        ],
        auditArgs: ['pip-audit', '--disable-pip', '-r', requirementsFile],
    };
}

/**
 * Build a sandbox-safe environment for uv commands.
 *
 * @returns {NodeJS.ProcessEnv}
 */
export function buildUvEnv() {
    return { ...uvEnvironment };
}

/**
 * Run the Python dependency audit against the Django package lockfile.
 *
 * @returns {Promise<void>}
 */
export async function main() {
    const tempDirectory = await mkdtemp(path.join(tmpdir(), 'magic-sso-audit-'));
    const requirementsFile = path.join(tempDirectory, 'requirements.txt');
    const { exportArgs, auditArgs } = buildAuditArgs(requirementsFile);

    try {
        execFileSync('uv', exportArgs, {
            cwd: repositoryRoot,
            env: buildUvEnv(),
            stdio: 'inherit',
        });

        execFileSync('uvx', auditArgs, {
            cwd: repositoryRoot,
            env: buildUvEnv(),
            stdio: 'inherit',
        });
    } finally {
        await rm(tempDirectory, { recursive: true, force: true });
    }
}

if (import.meta.url === `file://${process.argv[1]}`) {
    await main();
}
