import { EventEmitter } from 'node:events';
import { readFileSync } from 'node:fs';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { enableDevOtp, parseEnvFile, resolveSourceConfigPath, runOtpDev } from './dev-otp.mjs';

const tempDirectories: string[] = [];

class FakeChild extends EventEmitter {
    readonly kill = vi.fn((_signal?: NodeJS.Signals) => true);
}

function createFakeProcess(env: NodeJS.ProcessEnv) {
    const handlers = new Map<NodeJS.Signals, () => void>();

    return {
        env,
        on(event: NodeJS.Signals, listener: () => void) {
            handlers.set(event, listener);
            return this;
        },
        removeListener(event: NodeJS.Signals, listener: () => void) {
            if (handlers.get(event) === listener) {
                handlers.delete(event);
            }

            return this;
        },
    };
}

async function createTempRepository(): Promise<string> {
    const root = await mkdtemp(join(tmpdir(), 'magic-sso-dev-otp-'));
    tempDirectories.push(root);
    return root;
}

describe('OTP development wrapper', () => {
    afterEach(async () => {
        await Promise.all(
            tempDirectories
                .splice(0, tempDirectories.length)
                .map((directory) => rm(directory, { force: true, recursive: true })),
        );
    });

    it('parses a minimal dotenv file and resolves the server-relative config path', async () => {
        const root = await createTempRepository();
        await mkdir(join(root, 'server'), { recursive: true });
        await writeFile(join(root, 'server/.env'), 'MAGICSSO_CONFIG_FILE=./local.toml\n', 'utf8');

        expect(parseEnvFile('A=one\n# ignored\nB = two\n')).toEqual({ A: 'one', B: 'two' });
        expect(resolveSourceConfigPath({}, root)).toBe(join(root, 'server/local.toml'));
        expect(resolveSourceConfigPath({ MAGICSSO_CONFIG_FILE: './custom.toml' }, root)).toBe(
            join(root, 'server/custom.toml'),
        );
    });

    it('replaces only the OTP configuration with the fixed local development policy', () => {
        const config = {
            auth: {
                emailSecret: 'email-secret',
                jwtSecret: 'jwt-secret',
                otp: { enabled: false },
            },
            sites: [],
        };

        expect(enableDevOtp(config, 'otp-secret')).toEqual({
            auth: {
                emailSecret: 'email-secret',
                jwtSecret: 'jwt-secret',
                otp: {
                    allowedAttempts: 3,
                    enabled: true,
                    expiration: '5m',
                    length: 6,
                    resendStrategy: 'rotate',
                    secret: 'otp-secret',
                },
            },
            sites: [],
        });
    });

    it('starts the normal development matrix with a temporary OTP config and direct mode', async () => {
        const root = await createTempRepository();
        const sourcePath = join(root, 'server/source.toml');
        const sourceContents = '[auth]\njwtSecret = "unchanged"\n';
        await mkdir(join(root, 'server'), { recursive: true });
        await writeFile(sourcePath, sourceContents, 'utf8');

        const child = new FakeChild();
        let renderedConfig = '';
        const spawnFn = vi.fn((_command, _args, options) => {
            expect(options.env.MAGICSSO_DIRECT_USE).toBe('true');
            expect(options.env.MAGICSSO_CONFIG_FILE).not.toBe(sourcePath);
            renderedConfig = readFileSync(options.env.MAGICSSO_CONFIG_FILE, 'utf8');
            return child;
        });
        const spawnSyncFn = vi.fn(() => ({ signal: null, status: 0 }));
        const fakeProcess = createFakeProcess({ MAGICSSO_CONFIG_FILE: './source.toml' });

        const run = runOtpDev({
            direct: true,
            loadConfigCore: async () => ({
                parseMagicSsoTomlConfig: () => ({ auth: { jwtSecret: 'unchanged' }, sites: [] }),
                stringifyMagicSsoTomlConfig: (config) => JSON.stringify(config),
            }),
            processObject: fakeProcess,
            repositoryRoot: root,
            spawnFn,
            spawnSyncFn,
        });
        await new Promise<void>((resolve) => setImmediate(resolve));
        child.emit('exit', 0, null);

        await expect(run).resolves.toBe(0);
        expect(spawnSyncFn).toHaveBeenCalledWith(
            'pnpm',
            ['--filter', '@magic-link-sso/config-core', 'build'],
            expect.objectContaining({ cwd: root, stdio: 'inherit' }),
        );
        expect(spawnFn).toHaveBeenCalledWith(
            'pnpm',
            ['dev'],
            expect.objectContaining({ cwd: root, stdio: 'inherit' }),
        );
        expect(JSON.parse(renderedConfig)).toMatchObject({
            auth: { otp: { enabled: true, length: 6 } },
        });
        expect(await readFile(sourcePath, 'utf8')).toBe(sourceContents);
    });
});
