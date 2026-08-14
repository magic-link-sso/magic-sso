// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Wojciech Polak

import { describe, expect, it } from 'vitest';
import magicSsoModule from './module';

describe('Magic Link SSO Nuxt module', () => {
    it('exposes its package metadata', async (): Promise<void> => {
        await expect(magicSsoModule.getMeta?.()).resolves.toMatchObject({
            name: '@magic-link-sso/nuxt',
            configKey: 'magicSso',
        });
    });
});
