// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Wojciech Polak

import { describe, expect, it, vi } from 'vitest';

describe('@magic-link-sso/core entrypoint', () => {
    it('loads when a framework provides a document global', async () => {
        vi.stubGlobal('document', {});
        vi.resetModules();

        const { buildLoginTarget } = await import('../src/index.js');

        expect(
            buildLoginTarget({
                appOrigin: 'https://app.example.test',
                returnUrl: '/protected',
            }),
        ).toBe('/login?returnUrl=https%3A%2F%2Fapp.example.test%2Fprotected');

        vi.unstubAllGlobals();
    });
});
