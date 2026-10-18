// SPDX-License-Identifier: GPL-3.0-or-later
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { buildApp } from './app.js';
import { parseMagicSsoConfigToml, type AppConfig } from './config.js';
import * as configModule from './config.js';

const fixture = readFileSync(
    new URL('../../packages/config-core/src/browser-sso.fixture.toml', import.meta.url),
    'utf8',
);
const directories: string[] = [];
function config(): AppConfig {
    const directory = mkdtempSync(join(tmpdir(), 'browser-sso-server-'));
    directories.push(directory);
    return {
        ...parseMagicSsoConfigToml(fixture, 'browser-sso.fixture.toml'),
        verifyTokenStoreDir: join(directory, 'tokens'),
        signInEmailRateLimitStoreDir: join(directory, 'limits'),
        reload: { secret: 'fixture-reload-secret-0123456789abcdefghij' },
    };
}
afterEach(() => {
    vi.restoreAllMocks();
    for (const directory of directories.splice(0)) {
        rmSync(directory, { recursive: true, force: true });
    }
});

describe('browser SSO staged rollout', () => {
    it('advertises the enabled versioned issuer capability', async () => {
        const settings = config();
        const policy = settings.browserSso;
        if (!policy) {
            throw new Error('Expected browser SSO policy');
        }
        const app = await buildApp({
            logger: false,
            config: { ...settings, browserSso: { ...policy, enabled: true } },
        });
        try {
            expect((await app.inject('/sso/capabilities')).json()).toMatchObject({
                browserSso: { version: 1, enabled: true, loginUi: 'hosted' },
            });
        } finally {
            await app.close();
        }
    });

    it('preserves prepared registrations when reloading grants and keeps legacy routes working', async () => {
        const settings = config();
        const app = await buildApp({ config: settings, logger: false });
        const candidate = structuredClone(settings);
        candidate.sites[0]?.accessRules.set('friend@example.com', new Set(['*']));
        vi.spyOn(configModule, 'loadConfig').mockReturnValue(candidate);
        try {
            const response = await app.inject({
                method: 'POST',
                url: '/internal/access-config/reload',
                headers: { 'x-magic-sso-reload-secret': settings.reload?.secret ?? '' },
            });
            expect(response.statusCode).toBe(200);
            expect(settings.sites[0]?.sso).toEqual(candidate.sites[0]?.sso);
            expect(settings.sites[0]?.accessRules.has('friend@example.com')).toBe(true);
            expect((await app.inject('/healthz')).statusCode).toBe(200);
            expect((await app.inject('/sso/capabilities')).json()).toEqual({
                browserSso: { version: 1, enabled: false },
            });
            for (const endpoint of ['/sso/authorize', '/sso/exchange', '/sso/signout']) {
                expect((await app.inject(endpoint)).statusCode).toBe(409);
            }
        } finally {
            await app.close();
        }
    });

    it.each([
        'policy',
        'bootstrap',
        'redirectUri',
        'startUri',
        'signedOutUri',
        'remove-registration',
        'launcher',
    ])(
        'requires a restart for a change to %s without adopting other candidate grants',
        async (field) => {
            const settings = config();
            if (field === 'bootstrap' && settings.browserSso) {
                settings.browserSso.enabled = true;
            }
            const app = await buildApp({ config: settings, logger: false });
            const candidate = structuredClone(settings);
            const site = candidate.sites[0];
            const policy = candidate.browserSso;
            const registration = site?.sso?.[0];
            if (!site || !policy || !registration) {
                throw new Error('Expected prepared SSO config');
            }
            if (field === 'policy') {
                policy.sessionLifetimeSeconds = 3600;
            } else if (field === 'bootstrap') {
                policy.bootstrapEnabled = true;
            } else if (field === 'remove-registration') {
                site.sso = undefined;
            } else if (field === 'launcher') {
                site.launcher = {
                    name: 'Reports',
                    launchUrl: 'https://app.example.com/reports',
                    scope: '*',
                };
            } else if (field === 'redirectUri') {
                registration.redirectUri = 'https://app.example.com/other/callback';
            } else if (field === 'startUri') {
                registration.startUri = 'https://app.example.com/other/start';
            } else {
                registration.signedOutUri = 'https://app.example.com/other/signed-out';
            }
            site.accessRules.set('friend@example.com', new Set(['*']));
            vi.spyOn(configModule, 'loadConfig').mockReturnValue(candidate);
            try {
                const response = await app.inject({
                    method: 'POST',
                    url: '/internal/access-config/reload',
                    headers: { 'x-magic-sso-reload-secret': settings.reload?.secret ?? '' },
                });
                expect(response.statusCode).toBe(409);
                expect(response.json()).toEqual({
                    message: 'Reload only supports site access changes.',
                });
                expect(settings.sites[0]?.accessRules.has('friend@example.com')).toBe(false);
                expect(settings.sites[0]?.sso?.[0]?.redirectUri).toBe(
                    'https://app.example.com/sso/callback',
                );
            } finally {
                await app.close();
            }
        },
    );
});
