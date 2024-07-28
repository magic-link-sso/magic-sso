// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Wojciech Polak

import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { protectedBadgeUrl, signinBadgeUrl } from './index.js';

const packageDir = path.dirname(fileURLToPath(import.meta.url));
const stylesPath = path.join(packageDir, 'styles.css');

describe('magic-sso-example-ui', () => {
    it('exports file URLs for both shared badges', () => {
        expect(signinBadgeUrl).toMatch(/signin-page-badge\.svg$/u);
        expect(protectedBadgeUrl).toMatch(/protected-page-badge\.svg$/u);
        expect(signinBadgeUrl.startsWith('file://')).toBe(true);
        expect(protectedBadgeUrl.startsWith('file://')).toBe(true);
    });

    it('contains the canonical shared layout selectors', async () => {
        const styles = await readFile(stylesPath, 'utf8');

        expect(styles).toContain('.shell');
        expect(styles).toContain('.hero-top');
        expect(styles).toContain('.login-panel');
        expect(styles).toContain('.button-spinner-visible');
        expect(styles).toContain('.button-secondary');
        expect(styles).toContain('color: #0f172a;');
        expect(styles).toContain('background: rgba(255, 255, 255, 0.92);');
        expect(styles).toContain('@media (prefers-color-scheme: dark)');
    });
});
