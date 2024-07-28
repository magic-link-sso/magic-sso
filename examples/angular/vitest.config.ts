// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Wojciech Polak

import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vitest/config';

const packageDir = dirname(fileURLToPath(import.meta.url));

export default defineConfig({
    resolve: {
        alias: {
            '@magic-link-sso/angular': resolve(packageDir, '../../packages/angular/src/index.ts'),
            '@magic-link-sso/angular/core': resolve(
                packageDir,
                '../../packages/angular/src/lib/core.ts',
            ),
        },
    },
    test: {
        include: ['tests/**/*.test.ts'],
        exclude: ['dist/**', 'node_modules/**'],
    },
});
