import { EventEmitter } from 'node:events';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { tmpdir } from 'node:os';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
    buildManagerDevEnvironment,
    parseEnvFile,
    renderManagerDevFiles,
    resolveManagerDevPaths,
    runManagerDevStack,
} from './dev-manager.mjs';

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
    const root = await mkdtemp(join(tmpdir(), 'magic-sso-manager-dev-'));
    tempDirectories.push(root);
    return root;
}

async function writeRepositoryFile(
    root: string,
    relativePath: string,
    contents: string,
): Promise<void> {
    const filePath = join(root, relativePath);
    await mkdir(dirname(filePath), { recursive: true });
    await writeFile(filePath, contents, 'utf8');
}

describe('manager dev stack helpers', () => {
    afterEach(async () => {
        await Promise.all(
            tempDirectories
                .splice(0, tempDirectories.length)
                .map((directory) => rm(directory, { force: true, recursive: true })),
        );
    });

    it('parses simple dotenv-style files', () => {
        expect(parseEnvFile('A=1\n# comment\nB = two\n\nC=three=four\n')).toEqual({
            A: '1',
            B: 'two',
            C: 'three=four',
        });
    });

    it('builds local manager dev defaults around the repo runtime paths', async () => {
        const root = await createTempRepository();
        await writeRepositoryFile(
            root,
            'manager/.env',
            [
                'MAGICSSO_COOKIE_NAME=magic-sso',
                'MANAGER_ALLOWED_EMAIL=manager@example.com',
                'PHOTOS_OWNER_EMAIL=owner@example.com',
            ].join('\n'),
        );

        const env = buildManagerDevEnvironment(
            {
                MAGICSSO_DEV_CSRF_SECRET: 'manager-dev-csrf-secret-1234567890abc',
                MAGICSSO_DEV_EMAIL_SECRET: 'manager-dev-email-secret-1234567890ab',
                MAGICSSO_JWT_SECRET: 'manager-dev-jwt-secret-1234567890abcd',
                MAGICSSO_PREVIEW_SECRET: 'manager-dev-preview-secret-123456789',
                MANAGER_RELOAD_SECRET: 'manager-dev-reload-secret-1234567890',
            },
            root,
        );

        expect(env.MAGICSSO_CONFIG_FILE).toBe(join(root, 'manager/runtime/magic-sso.runtime.toml'));
        expect(env.MAGICSSO_MANAGER_CONFIG_FILE).toBe(join(root, 'manager/runtime/manager.toml'));
        expect(env.MAGIC_GATE_RENDER_PUBLIC_ORIGIN).toBe('http://localhost:4306');
        expect(env.MAGIC_GATE_RENDER_UPSTREAM_URL).toBe('http://127.0.0.1:4311');
        expect(env.MANAGER_DEV_PHOTOS_ORIGIN).toBe('http://localhost:5001');
        expect(env.MANAGER_DEV_SMTP_HOST).toBe('127.0.0.1');
        expect(env.MANAGER_AUDIT_INTEGRITY_KEY).toBe('manager-dev-audit-integrity-key-1234567890');
        expect(env.MAILPIT_SMTP_PORT).toBe('1025');
        expect(env.PHOTOS_OWNER_EMAIL).toBe('owner@example.com');
        expect(env.PHOTOS_FRIEND_EMAIL).toBe('friend@example.com');
        expect(env.PHOTOS_FAMILY_EMAIL).toBe('family@example.com');
    });

    it('renders local manager dev configs with host-side URLs and relative manager paths', async () => {
        const root = await createTempRepository();
        await writeRepositoryFile(
            root,
            'manager/.env',
            'PHOTOS_OWNER_EMAIL=owner@example.com\nMAGICSSO_COOKIE_MAX_AGE=3600\nMAGICSSO_COOKIE_NAME=magic-sso\nMANAGER_ALLOWED_EMAIL=manager@example.com\n',
        );
        await writeRepositoryFile(
            root,
            'manager/dev/manager.local.toml.template',
            [
                'baseConfigFile = "./magic-sso.base.toml"',
                'integrityKey = "${MANAGER_AUDIT_INTEGRITY_KEY}"',
                'url = "${MANAGER_DEV_SERVER_ORIGIN}/internal/access-config/reload"',
                'port = ${MANAGER_UPSTREAM_PORT}',
            ].join('\n'),
        );
        await writeRepositoryFile(
            root,
            'manager/dev/magic-sso.base.local.toml.template',
            'appUrl = "${MANAGER_DEV_SERVER_ORIGIN}"\nhost = "${MANAGER_DEV_SMTP_HOST}"\nport = ${MAILPIT_SMTP_PORT}\norigin = "${MANAGER_DEV_PUBLIC_ORIGIN}"\nphotosOrigin = "${MANAGER_DEV_PHOTOS_ORIGIN}"\nemail = "${PHOTOS_OWNER_EMAIL}"\n',
        );
        await writeRepositoryFile(
            root,
            'manager/dev/magic-gate.local.toml.template',
            'port = ${MANAGER_PUBLIC_PORT}\npublicOrigin = "${MAGIC_GATE_RENDER_PUBLIC_ORIGIN}"\nupstreamUrl = "${MAGIC_GATE_RENDER_UPSTREAM_URL}"\nserverUrl = "${MAGIC_GATE_RENDER_SERVER_URL}"\n',
        );
        await writeRepositoryFile(
            root,
            'manager/dev/manager-state.json.template',
            '{"email":"${PHOTOS_OWNER_EMAIL}"}\n',
        );

        const paths = resolveManagerDevPaths(root);
        const env = buildManagerDevEnvironment(
            {
                MAGICSSO_DEV_CSRF_SECRET: 'manager-dev-csrf-secret-1234567890abc',
                MAGICSSO_DEV_EMAIL_SECRET: 'manager-dev-email-secret-1234567890ab',
                MAGICSSO_JWT_SECRET: 'manager-dev-jwt-secret-1234567890abcd',
                MAGICSSO_PREVIEW_SECRET: 'manager-dev-preview-secret-123456789',
                MANAGER_RELOAD_SECRET: 'manager-dev-reload-secret-1234567890',
            },
            root,
        );

        renderManagerDevFiles(paths, env);

        const managerConfig = await readFile(paths.managerConfigFilePath, 'utf8');
        const baseConfig = await readFile(
            join(paths.managerRuntimeDirectory, 'magic-sso.base.toml'),
            'utf8',
        );
        const gateConfig = await readFile(paths.gateConfigFilePath, 'utf8');
        const stateFile = await readFile(paths.managerStateFilePath, 'utf8');

        expect(managerConfig).toContain('baseConfigFile = "./magic-sso.base.toml"');
        expect(managerConfig).toContain(
            'integrityKey = "manager-dev-audit-integrity-key-1234567890"',
        );
        expect(managerConfig).toContain(
            'url = "http://127.0.0.1:3000/internal/access-config/reload"',
        );
        expect(managerConfig).toContain('port = 4311');
        expect(baseConfig).toContain('appUrl = "http://127.0.0.1:3000"');
        expect(baseConfig).toContain('host = "127.0.0.1"');
        expect(baseConfig).toContain('origin = "http://localhost:4306"');
        expect(baseConfig).toContain('photosOrigin = "http://localhost:5001"');
        expect(gateConfig).toContain('port = 4306');
        expect(gateConfig).toContain('publicOrigin = "http://localhost:4306"');
        expect(gateConfig).toContain('upstreamUrl = "http://127.0.0.1:4311"');
        expect(gateConfig).toContain('serverUrl = "http://127.0.0.1:3000"');
        expect(stateFile).toContain('"email":"owner@example.com"');
    });

    it('boots Mailpit, applies the runtime once, then starts the hot-reload services', async () => {
        const root = await createTempRepository();
        await writeRepositoryFile(
            root,
            'manager/.env',
            [
                'MAGICSSO_COOKIE_MAX_AGE=3600',
                'MAGICSSO_COOKIE_NAME=magic-sso',
                'MAGICSSO_DEV_CSRF_SECRET=manager-dev-csrf-secret-1234567890abc',
                'MAGICSSO_DEV_EMAIL_SECRET=manager-dev-email-secret-1234567890ab',
                'MAGICSSO_JWT_SECRET=manager-dev-jwt-secret-1234567890abcd',
                'MAGICSSO_PREVIEW_SECRET=manager-dev-preview-secret-123456789',
                'MANAGER_ALLOWED_EMAIL=manager@example.com',
                'MANAGER_RELOAD_SECRET=manager-dev-reload-secret-1234567890',
                'PHOTOS_FAMILY_EMAIL=family@example.com',
                'PHOTOS_FRIEND_EMAIL=friend@example.com',
                'PHOTOS_OWNER_EMAIL=owner@example.com',
            ].join('\n'),
        );
        await writeRepositoryFile(
            root,
            'manager/dev/manager.local.toml.template',
            'baseConfigFile = "./magic-sso.base.toml"\n',
        );
        await writeRepositoryFile(
            root,
            'manager/dev/magic-sso.base.local.toml.template',
            'appUrl = "${MANAGER_DEV_SERVER_ORIGIN}"\n',
        );
        await writeRepositoryFile(
            root,
            'manager/dev/magic-gate.local.toml.template',
            'port = ${MANAGER_PUBLIC_PORT}\nupstreamUrl = "${MAGIC_GATE_RENDER_UPSTREAM_URL}"\n',
        );
        await writeRepositoryFile(
            root,
            'manager/dev/manager-state.json.template',
            '{"email":"${PHOTOS_OWNER_EMAIL}"}\n',
        );
        await writeRepositoryFile(root, 'manager/docker-compose.yml', 'services:\n  mailpit:\n');

        const fakeProcess = createFakeProcess({});
        const spawnedChildren = [
            new FakeChild(),
            new FakeChild(),
            new FakeChild(),
            new FakeChild(),
            new FakeChild(),
        ];
        const childQueue = [...spawnedChildren];
        const spawnFn = vi.fn().mockImplementation(() => {
            const child = childQueue.shift();
            if (typeof child === 'undefined') {
                throw new Error('Unexpected extra child process');
            }

            return child;
        });
        const spawnSyncFn = vi.fn(() => ({
            signal: null,
            status: 0,
        }));

        const promise = runManagerDevStack({
            processObject: fakeProcess,
            repositoryRoot: root,
            spawnFn,
            spawnSyncFn,
        });

        spawnedChildren[3]?.emit('exit', 0, null);

        await expect(promise).resolves.toBe(0);
        expect(spawnSyncFn.mock.calls).toEqual([
            [
                'docker',
                [
                    'compose',
                    '--env-file',
                    join(root, 'manager/.env'),
                    '-f',
                    join(root, 'manager/docker-compose.yml'),
                    'up',
                    '-d',
                    'mailpit',
                ],
                expect.objectContaining({ cwd: root, stdio: 'inherit' }),
            ],
            [
                'pnpm',
                ['--filter', '@magic-link-sso/config-core', 'build'],
                expect.objectContaining({ cwd: root, stdio: 'inherit' }),
            ],
            [
                'pnpm',
                ['--filter', 'magic-sso-manager', 'build'],
                expect.objectContaining({ cwd: root, stdio: 'inherit' }),
            ],
            [
                'node',
                ['manager/dev/bootstrap-local-managed-stack.mjs'],
                expect.objectContaining({ cwd: root, stdio: 'inherit' }),
            ],
        ]);
        expect(spawnFn.mock.calls).toEqual([
            [
                'pnpm',
                ['--filter', '@magic-link-sso/config-core', 'build:watch'],
                expect.objectContaining({ cwd: root, stdio: 'inherit' }),
            ],
            [
                'pnpm',
                ['--filter', 'magic-sso-server', 'dev'],
                expect.objectContaining({ cwd: root, stdio: 'inherit' }),
            ],
            [
                'pnpm',
                ['--filter', 'example-app-photos', 'dev'],
                expect.objectContaining({
                    cwd: root,
                    env: expect.objectContaining({
                        MAGICSSO_DIRECT_USE: 'false',
                        MAGICSSO_PUBLIC_ORIGIN: 'http://localhost:5001',
                        MAGICSSO_SERVER_URL: 'http://127.0.0.1:3000',
                    }),
                    stdio: 'inherit',
                }),
            ],
            [
                'pnpm',
                ['--filter', 'magic-sso-manager', 'dev'],
                expect.objectContaining({ cwd: root, stdio: 'inherit' }),
            ],
            [
                'pnpm',
                ['--filter', 'magic-sso-gate', 'dev'],
                expect.objectContaining({
                    cwd: root,
                    env: expect.objectContaining({
                        MAGIC_GATE_CONFIG_FILE: join(root, 'manager/runtime/magic-gate.toml'),
                    }),
                    stdio: 'inherit',
                }),
            ],
        ]);
    });
});
