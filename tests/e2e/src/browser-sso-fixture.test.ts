// SPDX-License-Identifier: MIT
import { afterEach, expect, it, vi } from 'vitest';
import type { BrowserSsoFixtureRole } from './browser-sso-fixture.js';

const roles: BrowserSsoFixtureRole[] = [
    'issuer',
    'gate-a',
    'gate-b',
    'next',
    'nuxt',
    'django',
    'angular',
    'fastify',
    'compat',
];

afterEach(() => {
    vi.unstubAllEnvs();
    vi.resetModules();
});

it.each(['false', 'true'])(
    'keeps SSO listeners outside the Linux ephemeral port range (HTTPS=%s)',
    async (https): Promise<void> => {
        vi.stubEnv('MAGICSSO_E2E_SSO_HTTPS', https);
        vi.resetModules();
        const fixture = await import('./browser-sso-fixture.js');
        const publicPorts = fixture.browserSsoTestPorts;
        const listenPorts = roles.map((role) => fixture.browserSsoListenPort(role));
        const ports = [
            ...publicPorts,
            ...(https === 'true' ? listenPorts : []),
            fixture.browserSsoUpstreamPort,
            Number(new URL(fixture.browserSsoProxyUrl).port),
        ];

        // Linux's default ephemeral range starts at 32768.
        expect(new Set(ports).size).toBe(ports.length);
        for (const port of ports) {
            expect(port).toBeGreaterThan(1023);
            expect(port).toBeLessThan(32768);
        }
    },
);
