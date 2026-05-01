// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Wojciech Polak

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

describe('gate dev script', () => {
    it('uses Node watch mode with tsx import for clean shutdowns', () => {
        const packageJson = readFileSync(join(import.meta.dirname, '..', 'package.json'), 'utf8');

        expect(packageJson).toContain('"dev": "node --watch --import tsx src/main.ts"');
    });
});
