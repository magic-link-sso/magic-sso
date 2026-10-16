// SPDX-License-Identifier: MIT

import { afterEach, describe, expect, it, vi } from 'vitest';

vi.mock('nuxt/config', () => ({ defineNuxtConfig: (config: unknown): unknown => config }));

afterEach(() => {
    vi.unstubAllGlobals();
    vi.unstubAllEnvs();
    vi.resetModules();
});

describe('Nuxt example deployment configuration', () => {
    it.each(['true', 'false'])(
        'keeps whole-app protection and proxy trust aligned for %s',
        async (flag) => {
            vi.stubEnv('MAGICSSO_AUTH_EVERYWHERE', flag);
            vi.stubEnv('MAGICSSO_TRUST_PROXY', flag);
            const { default: config } = await import('../nuxt.config.js');
            const enabled = flag === 'true';
            expect(config).toMatchObject({
                modules: [['@magic-link-sso/nuxt', { authEverywhere: enabled }]],
                runtimeConfig: {
                    magicSso: { authEverywhere: enabled, trustProxy: enabled },
                    public: { magicSso: { authEverywhere: enabled, trustProxy: enabled } },
                },
            });
        },
    );
});
