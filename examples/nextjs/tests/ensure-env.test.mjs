// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Wojciech Polak

import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

async function importEnsureEnvModule() {
    return import('../scripts/ensure-env.mjs');
}

describe('ensure-env script', () => {
    it('copies the example env file when .env.local is missing', async () => {
        const tempDir = await mkdtemp(path.join(tmpdir(), 'magic-sso-nextjs-env-'));
        const sourcePath = path.join(tempDir, '.env.local.example');
        const targetPath = path.join(tempDir, '.env.local');

        try {
            await writeFile(
                sourcePath,
                [
                    'MAGICSSO_JWT_SECRET=example-secret',
                    'MAGICSSO_PREVIEW_SECRET=example-preview-secret',
                ].join('\n'),
                'utf8',
            );

            const { ensureEnvFile } = await importEnsureEnvModule();
            await ensureEnvFile(sourcePath, targetPath);

            assert.strictEqual(
                await readFile(targetPath, 'utf8'),
                [
                    'MAGICSSO_JWT_SECRET=example-secret',
                    'MAGICSSO_PREVIEW_SECRET=example-preview-secret',
                ].join('\n'),
            );
        } finally {
            await rm(tempDir, { force: true, recursive: true });
        }
    });

    it('appends missing defaults to an existing .env.local file', async () => {
        const tempDir = await mkdtemp(path.join(tmpdir(), 'magic-sso-nextjs-env-'));
        const sourcePath = path.join(tempDir, '.env.local.example');
        const targetPath = path.join(tempDir, '.env.local');

        try {
            await writeFile(
                sourcePath,
                [
                    'MAGICSSO_JWT_SECRET=example-secret',
                    'MAGICSSO_PREVIEW_SECRET=example-preview-secret',
                    'MAGICSSO_SERVER_URL=http://localhost:3000',
                    'MAGICSSO_PUBLIC_ORIGIN=http://localhost:3001',
                ].join('\n'),
                'utf8',
            );
            await writeFile(targetPath, 'MAGICSSO_JWT_SECRET=custom-secret\n', 'utf8');

            const { ensureEnvFile } = await importEnsureEnvModule();
            await ensureEnvFile(sourcePath, targetPath);

            assert.strictEqual(
                await readFile(targetPath, 'utf8'),
                [
                    'MAGICSSO_JWT_SECRET=custom-secret',
                    'MAGICSSO_PREVIEW_SECRET=example-preview-secret',
                    'MAGICSSO_SERVER_URL=http://localhost:3000',
                    'MAGICSSO_PUBLIC_ORIGIN=http://localhost:3001',
                    '',
                ].join('\n'),
            );
        } finally {
            await rm(tempDir, { force: true, recursive: true });
        }
    });

    it('repairs generated placeholder secrets in an existing .env.local file', async () => {
        const tempDir = await mkdtemp(path.join(tmpdir(), 'magic-sso-nextjs-env-'));
        const sourcePath = path.join(tempDir, '.env.local.example');
        const targetPath = path.join(tempDir, '.env.local');

        try {
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
            await ensureEnvFile(sourcePath, targetPath);

            assert.strictEqual(
                await readFile(targetPath, 'utf8'),
                [
                    'MAGICSSO_JWT_SECRET=example-jwt-secret',
                    'MAGICSSO_PREVIEW_SECRET=example-preview-secret',
                    'MAGICSSO_SERVER_URL=http://localhost:3000',
                    '',
                ].join('\n'),
            );
        } finally {
            await rm(tempDir, { force: true, recursive: true });
        }
    });
});
