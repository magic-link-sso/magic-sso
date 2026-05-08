// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Wojciech Polak

import { resolve } from 'node:path';
import { defineConfig } from 'vitest/config';

const config = defineConfig({
    resolve: {
        alias: {
            '@': resolve(import.meta.dirname, 'src'),
        },
    },
    test: {
        environment: 'node',
    },
});

export default config;
