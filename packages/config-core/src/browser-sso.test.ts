// SPDX-License-Identifier: GPL-3.0-or-later
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import {
    parseMagicSsoConfigToml,
    parseMagicSsoTomlConfig,
    stringifyMagicSsoTomlConfig,
} from './index.js';

const fixture = readFileSync(new URL('./browser-sso.fixture.toml', import.meta.url), 'utf8');
const path = '/tmp/browser-sso.toml';

describe('browser SSO configuration contract', () => {
    it('retains legacy configuration without enabling or configuring browser SSO', () => {
        const legacy = fixture
            .replace('[auth.sso]\nenabled = false\n', '')
            .replace(/\n\[\[sites.sso\]\][\s\S]+$/u, '');
        const config = parseMagicSsoConfigToml(legacy, path);
        expect(config.browserSso).toBeUndefined();
        expect(config.sites[0]?.sso).toBeUndefined();
        const explicitlyOff = fixture
            .replaceAll('https://sso.example.com', 'http://localhost:3000')
            .replaceAll('https://app.example.com', 'http://localhost:4000')
            .replace(/\n\[\[sites.sso\]\][\s\S]+$/u, '');
        expect(parseMagicSsoConfigToml(explicitlyOff, path).browserSso?.enabled).toBe(false);
    });

    it('parses safe opt-in defaults and roundtrips exact registrations', () => {
        const config = parseMagicSsoConfigToml(fixture, path);
        expect(config.browserSso).toEqual({
            enabled: false,
            allowInsecureLocalhost: false,
            sessionLifetimeSeconds: 28800,
            requestLifetimeSeconds: 900,
            codeLifetimeSeconds: 60,
        });
        expect(config.sites[0]?.sso).toEqual([
            {
                redirectUri: 'https://app.example.com/sso/callback',
                startUri: 'https://app.example.com/sso/start',
                signedOutUri: 'https://app.example.com/signed-out',
            },
        ]);
        expect(
            parseMagicSsoConfigToml(
                stringifyMagicSsoTomlConfig(parseMagicSsoTomlConfig(fixture, path)),
                path,
            ),
        ).toEqual(config);
        expect(
            parseMagicSsoConfigToml(fixture.replace('enabled = false', 'enabled = true'), path)
                .browserSso?.enabled,
        ).toBe(true);
    });

    it('requires a separately enabled bootstrap policy and preserves it through TOML roundtrip', () => {
        expect(() =>
            parseMagicSsoConfigToml(
                fixture.replace('enabled = false', 'enabled = false\nbootstrapEnabled = true'),
                path,
            ),
        ).toThrow('bootstrapEnabled');
        const source = fixture.replace(
            'enabled = false',
            'enabled = true\nbootstrapEnabled = true',
        );
        const config = parseMagicSsoConfigToml(source, path);
        expect(config.browserSso?.bootstrapEnabled).toBe(true);
        expect(
            parseMagicSsoConfigToml(
                stringifyMagicSsoTomlConfig(parseMagicSsoTomlConfig(source, path)),
                path,
            ),
        ).toEqual(config);
    });
    it.each([
        'sessionLifetimeSeconds = 299',
        'sessionLifetimeSeconds = 86401',
        'requestLifetimeSeconds = 59',
        'requestLifetimeSeconds = 1801',
        'codeLifetimeSeconds = 14',
        'codeLifetimeSeconds = 121',
        'codeLifetimeSeconds = 30.5',
        'unknownPolicy = true',
    ])('rejects unbounded or unknown policy: %s', (setting) => {
        expect(() =>
            parseMagicSsoConfigToml(
                fixture.replace('enabled = false', `enabled = false\n${setting}`),
                path,
            ),
        ).toThrow();
    });

    it.each([
        'https://app.example.com/*',
        'https://evil.example.com/sso/callback',
        'https://app.example.com/sso/callback?target=evil',
        'https://app.example.com/sso/callback?',
        'https://app.example.com/sso/callback#',
        'https://app.example.com/sso/callback#fragment',
        'https://user:pass@app.example.com/sso/callback',
        'https://APP.example.com/sso/callback',
        'https://app.example.com:443/sso/callback',
        'https://app.example.com/sso/../callback',
        'https://app.example.com/sso/%2fcallback',
        'https://app.example.com/sso/%252fcallback',
        'http://app.example.com/sso/callback',
    ])('rejects unsafe callback registrations: %s', (redirectUri) => {
        expect(() =>
            parseMagicSsoConfigToml(
                fixture.replace(
                    'redirectUri = "https://app.example.com/sso/callback"',
                    `redirectUri = "${redirectUri}"`,
                ),
                path,
            ),
        ).toThrow(/sites\[app\].sso/u);
    });

    it('rejects different endpoint origins, duplicate registrations, and reserved cookie names', () => {
        expect(() =>
            parseMagicSsoConfigToml(
                fixture.replace(
                    'startUri = "https://app.example.com/sso/start"',
                    'startUri = "https://evil.example.com/sso/start"',
                ),
                path,
            ),
        ).toThrow(/one configured site origin/u);
        expect(() =>
            parseMagicSsoConfigToml(
                `${fixture}\n${fixture.slice(fixture.indexOf('[[sites.sso]]'))}`,
                path,
            ),
        ).toThrow(/one registration per public origin/u);
        expect(() =>
            parseMagicSsoConfigToml(
                `${fixture}\n[cookie]\nname = "__Host-magic-sso-browser"`,
                path,
            ),
        ).toThrow(/reserved browser SSO cookie/u);
        expect(() =>
            parseMagicSsoConfigToml(
                fixture.replace(
                    'startUri = "https://app.example.com/sso/start"',
                    'startUri = "https://app.example.com/sso/callback"',
                ),
                path,
            ),
        ).toThrow(/must be distinct/u);
    });

    it('requires a dedicated issuer hostname, including nonparticipating sites and different ports', () => {
        const shared = fixture.replace('https://sso.example.com', 'https://app.example.com:444');
        expect(() => parseMagicSsoConfigToml(shared, path)).toThrow(/dedicated issuer hostname/u);
        expect(() =>
            parseMagicSsoConfigToml(
                shared.replace('https://app.example.com:444', 'https://app.example.com.:444'),
                path,
            ),
        ).toThrow();
        expect(() =>
            parseMagicSsoConfigToml(
                `${fixture}\n[[sites]]\nid = "legacy"\norigins = ["https://sso.example.com:444"]\nallowedRedirectUris = ["https://sso.example.com:444/verify-email"]\nallowedEmails = ["owner@example.com"]`,
                path,
            ),
        ).toThrow(/dedicated issuer hostname/u);
    });

    it('permits only explicit loopback HTTP development on separate hostnames', () => {
        const local = fixture
            .replaceAll('https://sso.example.com', 'http://sso.localhost:3000')
            .replaceAll('https://app.example.com', 'http://app.localhost:4000');
        expect(() => parseMagicSsoConfigToml(local, path)).toThrow(/requires HTTPS/u);
        expect(
            parseMagicSsoConfigToml(
                local.replace('enabled = false', 'enabled = false\nallowInsecureLocalhost = true'),
                path,
            ).browserSso?.allowInsecureLocalhost,
        ).toBe(true);
        expect(() =>
            parseMagicSsoConfigToml(
                fixture
                    .replaceAll('https://sso.example.com', 'http://sso.example.com')
                    .replace('enabled = false', 'enabled = false\nallowInsecureLocalhost = true'),
                path,
            ),
        ).toThrow(/requires HTTPS/u);
    });

    it('requires a policy for registrations and at least one registration before enabling', () => {
        expect(() =>
            parseMagicSsoConfigToml(fixture.replace('[auth.sso]\nenabled = false\n', ''), path),
        ).toThrow(/Configure \[auth.sso\]/u);
        expect(() =>
            parseMagicSsoConfigToml(
                fixture
                    .replace('enabled = false', 'enabled = true')
                    .replace(/\n\[\[sites.sso\]\][\s\S]+$/u, ''),
                path,
            ),
        ).toThrow(/at least one/u);
    });
});
