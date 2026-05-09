// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Wojciech Polak

import { access, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';

async function importEnsureEnvModule(): Promise<typeof import('../scripts/ensure-env.mjs')> {
    return import('../scripts/ensure-env.mjs');
}

const tempDirectories: string[] = [];

afterEach(async (): Promise<void> => {
    await Promise.all(
        tempDirectories
            .splice(0)
            .map((directory) => rm(directory, { force: true, recursive: true })),
    );
});

async function createTempEnvDirectory(): Promise<string> {
    const directory = await mkdtemp(path.join(tmpdir(), 'magic-sso-photos-env-'));
    tempDirectories.push(directory);
    return directory;
}

describe('ensure-env script', () => {
    it('ships the example env file used by the build script', async () => {
        await expect(
            access(new URL('../.env.local.example', import.meta.url)),
        ).resolves.toBeUndefined();
    });

    it('copies the example env file when .env.local is missing', async () => {
        const tempDir = await createTempEnvDirectory();
        const sourcePath = path.join(tempDir, '.env.local.example');
        const targetPath = path.join(tempDir, '.env.local');

        await writeFile(
            sourcePath,
            [
                'MAGICSSO_JWT_SECRET=example-secret',
                'MAGICSSO_PREVIEW_SECRET=example-preview-secret',
            ].join('\n'),
            'utf8',
        );

        const { ensureEnvFile } = await importEnsureEnvModule();
        await ensureEnvFile(pathToFileURL(sourcePath), pathToFileURL(targetPath));

        expect(await readFile(targetPath, 'utf8')).toBe(
            [
                'MAGICSSO_JWT_SECRET=example-secret',
                'MAGICSSO_PREVIEW_SECRET=example-preview-secret',
            ].join('\n'),
        );
    });

    it('appends missing defaults to an existing .env.local file', async () => {
        const tempDir = await createTempEnvDirectory();
        const sourcePath = path.join(tempDir, '.env.local.example');
        const targetPath = path.join(tempDir, '.env.local');

        await writeFile(
            sourcePath,
            [
                'MAGICSSO_JWT_SECRET=example-secret',
                'MAGICSSO_PREVIEW_SECRET=example-preview-secret',
                'MAGICSSO_SERVER_URL=http://localhost:3000',
                'MAGICSSO_PUBLIC_ORIGIN=http://localhost:5001',
            ].join('\n'),
            'utf8',
        );
        await writeFile(targetPath, 'MAGICSSO_JWT_SECRET=custom-secret\n', 'utf8');

        const { ensureEnvFile } = await importEnsureEnvModule();
        await ensureEnvFile(pathToFileURL(sourcePath), pathToFileURL(targetPath));

        expect(await readFile(targetPath, 'utf8')).toBe(
            [
                'MAGICSSO_JWT_SECRET=custom-secret',
                'MAGICSSO_PREVIEW_SECRET=example-preview-secret',
                'MAGICSSO_SERVER_URL=http://localhost:3000',
                'MAGICSSO_PUBLIC_ORIGIN=http://localhost:5001',
                '',
            ].join('\n'),
        );
    });

    it('repairs generated placeholder secrets in an existing .env.local file', async () => {
        const tempDir = await createTempEnvDirectory();
        const sourcePath = path.join(tempDir, '.env.local.example');
        const targetPath = path.join(tempDir, '.env.local');

        await writeFile(
            sourcePath,
            [
                'MAGICSSO_JWT_SECRET=example-jwt-secret',
                'MAGICSSO_PREVIEW_SECRET=example-preview-secret',
                'MAGICSSO_SERVER_URL=http://localhost:3000',
            ].join('\n'),
            'utf8',
        );
        await writeFile(
            targetPath,
            [
                'MAGICSSO_JWT_SECRET=replace-me-with-a-long-random-jwt-secret',
                'MAGICSSO_PREVIEW_SECRET=replace-me-with-a-long-random-preview-secret',
            ].join('\n'),
            'utf8',
        );

        const { ensureEnvFile } = await importEnsureEnvModule();
        await ensureEnvFile(pathToFileURL(sourcePath), pathToFileURL(targetPath));

        expect(await readFile(targetPath, 'utf8')).toBe(
            [
                'MAGICSSO_JWT_SECRET=example-jwt-secret',
                'MAGICSSO_PREVIEW_SECRET=example-preview-secret',
                'MAGICSSO_SERVER_URL=http://localhost:3000',
                '',
            ].join('\n'),
        );
    });

    it('upgrades the previous default photos origin in an existing .env.local file', async () => {
        const tempDir = await createTempEnvDirectory();
        const sourcePath = path.join(tempDir, '.env.local.example');
        const targetPath = path.join(tempDir, '.env.local');

        await writeFile(
            sourcePath,
            [
                'MAGICSSO_PUBLIC_ORIGIN=http://localhost:5001',
                'MAGICSSO_SERVER_URL=http://localhost:3000',
            ].join('\n'),
            'utf8',
        );
        await writeFile(
            targetPath,
            [
                'MAGICSSO_PUBLIC_ORIGIN=http://localhost:3001',
                'MAGICSSO_SERVER_URL=http://localhost:3000',
            ].join('\n'),
            'utf8',
        );

        const { ensureEnvFile } = await importEnsureEnvModule();
        await ensureEnvFile(pathToFileURL(sourcePath), pathToFileURL(targetPath));

        expect(await readFile(targetPath, 'utf8')).toBe(
            [
                'MAGICSSO_PUBLIC_ORIGIN=http://localhost:5001',
                'MAGICSSO_SERVER_URL=http://localhost:3000',
                '',
            ].join('\n'),
        );
    });
});
