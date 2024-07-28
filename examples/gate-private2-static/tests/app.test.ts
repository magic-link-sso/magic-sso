// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Wojciech Polak

import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const packageRoot = process.cwd();

describe('private2 static example', () => {
    it('ships a static entrypoint with Gate-aware links', () => {
        const indexHtml = readFileSync(resolve(packageRoot, 'public/index.html'), 'utf8');

        expect(indexHtml).toContain('Your private2 static page is locked behind the gate.');
        expect(indexHtml).toContain('/_magicgate/session');
        expect(indexHtml).toContain('/_magicgate/logout');
        expect(indexHtml).toContain('/assets/app.css');
        expect(indexHtml).toContain('/assets/app.js');
    });

    it('ships static assets for the page shell', () => {
        const cssPath = resolve(packageRoot, 'public/assets/app.css');
        const jsPath = resolve(packageRoot, 'public/assets/app.js');

        expect(existsSync(cssPath)).toBe(true);
        expect(existsSync(jsPath)).toBe(true);
        expect(readFileSync(jsPath, 'utf8')).toContain('Static assets loaded through Gate.');
    });
});
