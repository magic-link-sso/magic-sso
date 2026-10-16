// SPDX-License-Identifier: MIT

import { afterEach, describe, expect, it, vi } from 'vitest';
import { useAppOrigin } from '../app/composables/useAppOrigin.js';

afterEach(() => {
    vi.unstubAllGlobals();
});

describe('Nuxt example public origin', () => {
    it.each([false, true])('trusts forwarding only when enabled (%s)', (trustProxy) => {
        vi.stubGlobal('useMagicSsoConfig', () => ({ publicOrigin: '', trustProxy }));
        const readUrl = vi.fn(
            () => new URL(trustProxy ? 'https://app.example.test/' : 'http://backend.local:43202/'),
        );
        vi.stubGlobal('useRequestURL', readUrl);
        expect(useAppOrigin()).toBe(
            trustProxy ? 'https://app.example.test' : 'http://backend.local:43202',
        );
        expect(readUrl).toHaveBeenCalledWith({
            xForwardedHost: trustProxy,
            xForwardedProto: trustProxy,
        });
    });
    it('prefers an explicit public origin to the backend URL', () => {
        vi.stubGlobal('useMagicSsoConfig', () => ({
            publicOrigin: 'https://configured.example.test',
            trustProxy: false,
        }));
        vi.stubGlobal('useRequestURL', () => new URL('http://backend.local:43202/'));
        expect(useAppOrigin()).toBe('https://configured.example.test');
    });
});
