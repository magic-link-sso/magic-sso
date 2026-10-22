// SPDX-License-Identifier: MIT
import { readFileSync } from 'node:fs';
import { createDecipheriv, createHash, hkdfSync } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { BROWSER_SSO_DEFAULTS, parseBrowserSsoCapabilities } from './browser-sso.js';

const fixtures: {
    enabled: unknown;
    disabled: unknown;
    authorization: { codeChallenge: string };
    exchange: { codeVerifier: string };
    transaction: {
        keyMaterial: string;
        cookieName: string;
        payload: { issuer: string; audience: string };
        sealed: string;
    };
} = JSON.parse(
    readFileSync(new URL('../test/fixtures/browser-sso-v1.json', import.meta.url), 'utf8'),
);

describe('browser SSO v1 contract', () => {
    it('freezes a portable sealed transaction vector using an independent crypto implementation', () => {
        const transaction = fixtures.transaction;
        const key = Buffer.from(
            hkdfSync(
                'sha256',
                transaction.keyMaterial,
                transaction.payload.issuer,
                `magic-link-sso/browser-sso/v1/transaction\n${transaction.payload.audience}`,
                32,
            ),
        );
        const envelope = Buffer.from(transaction.sealed.slice('v1.'.length), 'base64url');
        const decipher = createDecipheriv('aes-256-gcm', key, envelope.subarray(0, 12));
        decipher.setAAD(Buffer.from(transaction.cookieName));
        decipher.setAuthTag(envelope.subarray(-16));
        const json = Buffer.concat([
            decipher.update(envelope.subarray(12, -16)),
            decipher.final(),
        ]).toString('utf8');
        expect(JSON.parse(json)).toEqual(transaction.payload);
        const renamed = createDecipheriv('aes-256-gcm', key, envelope.subarray(0, 12));
        renamed.setAAD(Buffer.from(`${transaction.cookieName}-other`));
        renamed.setAuthTag(envelope.subarray(-16));
        renamed.update(envelope.subarray(12, -16));
        expect(() => renamed.final()).toThrow();
    });
    it('recognizes the explicit enabled and disabled wire fixtures', () => {
        expect(parseBrowserSsoCapabilities(fixtures.enabled)).toMatchObject({
            kind: 'supported',
            capabilities: {
                enabled: true,
                version: 1,
                requestLifetimeSeconds: BROWSER_SSO_DEFAULTS.requestLifetimeSeconds,
                transactionLifetimeSeconds: 990,
            },
        });
        expect(parseBrowserSsoCapabilities(fixtures.disabled)).toEqual({ kind: 'disabled' });
    });

    it('shares the RFC 7636 S256 example with non-TypeScript adapters', () => {
        expect(
            createHash('sha256').update(fixtures.exchange.codeVerifier).digest('base64url'),
        ).toBe(fixtures.authorization.codeChallenge);
    });

    it('distinguishes a version mismatch from malformed or absent capability data', () => {
        expect(parseBrowserSsoCapabilities({ browserSso: { version: 2, enabled: true } })).toEqual({
            kind: 'unsupported',
            version: 2,
        });
        for (const value of [
            null,
            {},
            { browserSso: {} },
            { browserSso: { version: 1 } },
            { browserSso: { version: 0, enabled: false } },
            { browserSso: { version: 1, enabled: 'false' } },
        ]) {
            expect(parseBrowserSsoCapabilities(value)).toEqual({ kind: 'malformed' });
        }
    });

    it('keeps hosted v1 support while identifying optional bootstrap versions', () => {
        const result = parseBrowserSsoCapabilities(fixtures.enabled);
        if (result.kind !== 'supported') {
            throw new Error('Missing fixture');
        }
        for (const appOwnedBootstrapVersion of [1, 2]) {
            expect(
                parseBrowserSsoCapabilities({
                    browserSso: { ...result.capabilities, appOwnedBootstrapVersion },
                }),
            ).toMatchObject({ kind: 'supported', capabilities: { appOwnedBootstrapVersion } });
        }
        for (const appOwnedBootstrapVersion of ['1', 0, -1, null, true]) {
            expect(
                parseBrowserSsoCapabilities({
                    browserSso: { ...result.capabilities, appOwnedBootstrapVersion },
                }),
            ).toEqual({ kind: 'malformed' });
        }
    });
    it.each([
        { requestLifetimeSeconds: 59 },
        { requestLifetimeSeconds: 1801 },
        { codeLifetimeSeconds: 0 },
        { codeLifetimeSeconds: 121 },
        { requestLifetimeSeconds: 900.5 },
        { transactionLifetimeSeconds: 900 },
        { codeChallengeMethods: ['plain'] },
        { loginUi: 'app-owned' },
    ])('refuses unsafe or inconsistent enabled capabilities (%j)', (overrides) => {
        const valid = parseBrowserSsoCapabilities(fixtures.enabled);
        if (valid.kind !== 'supported') {
            throw new Error('Expected valid fixture');
        }
        expect(
            parseBrowserSsoCapabilities({ browserSso: { ...valid.capabilities, ...overrides } }),
        ).toEqual({ kind: 'malformed' });
    });
});

// Behavioral acceptance is implemented in browser-sso-client.test.ts,
// server/src/browserSsoRoutes.test.ts, server/src/browserSsoStore.test.ts,
// and the cross-site HTTPS browser profiles under tests/e2e.
