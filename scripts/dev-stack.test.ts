import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { describe, expect, it } from 'vitest';
import { loadConfig as loadCoreConfig } from '../packages/config-core/src/index.js';

const repositoryRoot = process.cwd();

async function readRepositoryFile(relativePath: string): Promise<string> {
    return readFile(join(repositoryRoot, relativePath), 'utf8');
}

describe('workspace stack scripts', () => {
    it('exposes the manager stack compose helper from the workspace root', async () => {
        const packageJson = JSON.parse(await readRepositoryFile('package.json')) as {
            scripts?: Record<string, string>;
        };

        expect(packageJson.scripts?.['dev:manager']).toBe('node scripts/dev-manager.mjs');
        expect(packageJson.scripts?.['dev:manager:stack']).toBe(
            'docker compose --env-file manager/.env -f manager/docker-compose.yml up --build',
        );
        expect(packageJson.scripts?.['dev:photos']).toBe('pnpm --filter example-app-photos dev');
    });

    it('keeps the manager stack build context files inside the docker context', async () => {
        const dockerignore = await readRepositoryFile('.dockerignore');

        expect(dockerignore).toContain('!manager/');
        expect(dockerignore).toContain('!examples/photos/');
        expect(dockerignore).toContain('!packages/config-core/');
        expect(dockerignore).toContain('!packages/nextjs/');
    });

    it('uses a fast startup healthcheck without frequent steady-state polling', async () => {
        const composeFile = await readRepositoryFile('manager/docker-compose.yml');

        expect(composeFile).toContain('interval: 5m');
        expect(composeFile).toContain('start_interval: 5s');
        expect(composeFile).toContain('start_period: 30s');
        expect(composeFile).toContain("fetch('http://127.0.0.1:4311/healthz')");
        expect(composeFile).toContain('condition: service_healthy');
    });

    it('renders a managed-mode base config that the server accepts', async () => {
        const template = await readRepositoryFile('manager/dev/magic-sso.base.toml.template');
        const rendered = template.replaceAll(/\$\{([A-Z0-9_]+)\}/g, (_match, key: string) => {
            const values: Record<string, string> = {
                MAGICSSO_COOKIE_NAME: 'magic-sso',
                MAGICSSO_DEV_CSRF_SECRET: 'manager-dev-csrf-secret-1234567890abc',
                MAGICSSO_DEV_EMAIL_SECRET: 'manager-dev-email-secret-1234567890ab',
                MAGICSSO_JWT_SECRET: 'manager-dev-jwt-secret-1234567890abcd',
                MAGICSSO_PREVIEW_SECRET: 'manager-dev-preview-secret-123456789',
                MANAGER_ALLOWED_EMAIL: 'manager@example.com',
                MANAGER_PUBLIC_HOST: 'manager.localhost',
                MANAGER_PUBLIC_PORT: '4306',
                MANAGER_RELOAD_SECRET: 'manager-dev-reload-secret-1234567890',
                PHOTOS_PUBLIC_HOST: 'photos.localhost',
                PHOTOS_FAMILY_EMAIL: 'family@example.com',
                PHOTOS_FRIEND_EMAIL: 'friend@example.com',
                PHOTOS_OWNER_EMAIL: 'owner@example.com',
                SSO_PUBLIC_HOST: 'sso.localhost',
            };
            const value = values[key];
            if (typeof value !== 'string') {
                throw new Error(`Missing template value for ${key}`);
            }
            return value;
        });

        expect(rendered).not.toContain('maxAge =');
        const tempDirectory = await mkdtemp(join(tmpdir(), 'magic-sso-managed-mode-template-'));
        const configPath = join(tempDirectory, 'magic-sso.base.toml');

        try {
            await writeFile(configPath, rendered, 'utf8');
            const config = loadCoreConfig({
                MAGICSSO_CONFIG_FILE: configPath,
            });

            expect(config.cookieName).toBe('magic-sso');
            expect(config.jwtExpirationSeconds).toBe(3600);
        } finally {
            await rm(tempDirectory, { force: true, recursive: true });
        }
    });
});
