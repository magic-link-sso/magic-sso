// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Wojciech Polak

import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { config } from 'dotenv';
import { describe, expect, it } from 'vitest';

describe('fastify dev env loading', () => {
    it('keeps exported env values when loading .env defaults', async () => {
        const tempDir = await mkdtemp(path.join(tmpdir(), 'magic-sso-fastify-env-'));

        try {
            const dotenvPath = path.join(tempDir, '.env');
            await writeFile(dotenvPath, 'MAGICSSO_DIRECT_USE=false\n', 'utf8');

            const env: NodeJS.ProcessEnv = {
                MAGICSSO_DIRECT_USE: '1',
            };

            config({
                path: dotenvPath,
                processEnv: env,
            });

            expect(env.MAGICSSO_DIRECT_USE).toBe('1');
        } finally {
            await rm(tempDir, {
                force: true,
                recursive: true,
            });
        }
    });

    it('loads dotenv from the entrypoint instead of sourcing .env in the dev script', async () => {
        const [mainSource, packageJson] = await Promise.all([
            readFile(new URL('../src/main.ts', import.meta.url), 'utf8'),
            readFile(new URL('../package.json', import.meta.url), 'utf8'),
        ]);

        expect(mainSource).toContain("import 'dotenv/config';");
        expect(packageJson).toContain('"dev": "tsx watch src/main.ts"');
        expect(packageJson).not.toContain('[ -f ./.env ] && . ./.env');
    });

    it('allows root turbo dev tasks to receive MAGICSSO_DIRECT_USE', async () => {
        const turboJson = await readFile(new URL('../../../turbo.json', import.meta.url), 'utf8');

        expect(turboJson).toContain('"MAGICSSO_COOKIE_NAME"');
        expect(turboJson).toContain('"MAGICSSO_DIRECT_USE"');
        expect(turboJson).toContain('"MAGICSSO_JWT_SECRET"');
        expect(turboJson).toContain('"MAGICSSO_PREVIEW_SECRET"');
        expect(turboJson).toContain('"MAGICSSO_PUBLIC_ORIGIN"');
        expect(turboJson).toContain('"MAGICSSO_SERVER_URL"');
    });
});
