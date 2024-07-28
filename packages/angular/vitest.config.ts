// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Wojciech Polak

import { defineConfig } from 'vitest/config';

export default defineConfig({
    test: {
        include: ['src/**/*.test.ts'],
        exclude: ['dist/**', 'node_modules/**'],
    },
});
