// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Wojciech Polak

import { defineConfig } from 'vitest/config';

export default defineConfig({
    test: {
        include: ['tests/**/*.test.ts'],
        exclude: ['node_modules/**', '.nuxt/**', '.output/**'],
    },
});
