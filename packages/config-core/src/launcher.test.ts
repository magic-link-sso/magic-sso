// SPDX-License-Identifier: GPL-3.0-or-later
import { readFileSync } from 'node:fs';
import { expect, it } from 'vitest';
import {
    parseMagicSsoConfigToml,
    parseMagicSsoTomlConfig,
    stringifyMagicSsoTomlConfig,
} from './index.js';

const fixture = readFileSync(new URL('./browser-sso.fixture.toml', import.meta.url), 'utf8');
function source(settings: string): string {
    return `${fixture}\n[sites.launcher]\n${settings}`;
}

it('roundtrips explicit launcher metadata and defaults to full-site access', () => {
    const input = source(
        'name = "Documents"\nlaunchUrl = "https://app.example.com/reports?q=a%2Bb&tag=one&tag=two"',
    );
    const config = parseMagicSsoConfigToml(input, 'fixture');
    expect(config.sites[0]?.launcher).toEqual({
        name: 'Documents',
        launchUrl: 'https://app.example.com/reports?q=a%2Bb&tag=one&tag=two',
        scope: '*',
    });
    expect(
        parseMagicSsoConfigToml(
            stringifyMagicSsoTomlConfig(parseMagicSsoTomlConfig(input, 'fixture')),
            'roundtrip',
        ),
    ).toEqual(config);
    expect(
        parseMagicSsoConfigToml(`${input}\nscope = "reports"`, 'fixture').sites[0]?.launcher?.scope,
    ).toBe('reports');
});

it.each([
    'https://elsewhere.test/reports',
    'https://user:password@app.example.com/reports',
    'javascript:alert(1)',
    '//app.example.com/reports',
    'http://app.example.com/reports',
    'https://APP.example.com/reports',
    'https://app.example.com/reports#fragment',
    'https://app.example.com/reports#',
    'https://app.example.com/*',
    'https://app.example.com/%2freports',
    'https://app.example.com/%252freports',
    'https://app.example.com/sso/start',
    'https://app.example.com/sso/callback?code=bad',
    'https://app.example.com/signed-out',
])('rejects an unsafe or non-application launcher destination: %s', (url) => {
    expect(() =>
        parseMagicSsoConfigToml(source(`name = "Documents"\nlaunchUrl = "${url}"`), 'fixture'),
    ).toThrow();
});

it('requires an SSO registration and a matching allowed redirect path', () => {
    const input = source('name = "Documents"\nlaunchUrl = "https://app.example.com/reports"');
    expect(() =>
        parseMagicSsoConfigToml(
            input.replace(/\n\[\[sites.sso\]\][\s\S]*?\n\[sites.launcher\]/u, '\n[sites.launcher]'),
            'fixture',
        ),
    ).toThrow(/launcher/u);
    expect(() =>
        parseMagicSsoConfigToml(
            input.replace('"https://app.example.com/*"', '"https://app.example.com/allowed/*"'),
            'fixture',
        ),
    ).toThrow(/launcher/u);
    expect(() =>
        parseMagicSsoConfigToml(
            input
                .replace('/reports"', '/allowed-elsewhere"')
                .replace('"https://app.example.com/*"', '"https://app.example.com/allowed/*"'),
            'fixture',
        ),
    ).toThrow(/launcher/u);
});

it.each(['name = ""', 'scope = " "', `scope = "${'é'.repeat(129)}"`, 'unknown = true'])(
    'rejects invalid launcher fields: %s',
    (invalid) => {
        const settings = invalid.startsWith('name') ? invalid : `name = "Documents"\n${invalid}`;
        expect(() =>
            parseMagicSsoConfigToml(
                source(`${settings}\nlaunchUrl = "https://app.example.com/reports"`),
                'fixture',
            ),
        ).toThrow();
    },
);
