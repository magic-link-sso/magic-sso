// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Wojciech Polak

import { configDefaults, defineConfig } from 'vitest/config';

export default defineConfig({
    test: {
        environment: 'node',
        exclude: [...configDefaults.exclude, 'dist/**'],
    },
});
