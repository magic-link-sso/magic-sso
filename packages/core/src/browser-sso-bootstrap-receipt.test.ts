// SPDX-License-Identifier: MIT
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import {
    createBrowserSsoBootstrapReceipt,
    verifyBrowserSsoBootstrapReceipt,
    hashBrowserSsoToken,
    type BrowserSsoBootstrapReceiptContext,
} from './browser-sso-bootstrap-receipt.js';
const fixture: {
    keyMaterial: string;
    accessToken: string;
    context: BrowserSsoBootstrapReceiptContext;
    receipt: string;
} = JSON.parse(
    readFileSync(
        new URL('../test/fixtures/browser-sso-bootstrap-v1.json', import.meta.url),
        'utf8',
    ),
);
describe('bootstrap completion receipt', () => {
    it('matches the independent HKDF/HMAC fixture and exact full-JWT hash', async () => {
        expect(await hashBrowserSsoToken(fixture.accessToken)).toBe(
            fixture.context.accessTokenHash,
        );
        expect(await createBrowserSsoBootstrapReceipt(fixture.keyMaterial, fixture.context)).toBe(
            fixture.receipt,
        );
        expect(
            await verifyBrowserSsoBootstrapReceipt(
                fixture.keyMaterial,
                fixture.context,
                fixture.receipt,
            ),
        ).toBe(true);
    });
    it.each([
        { issuer: 'https://other-issuer.example.com' },
        { audience: 'https://other-app.example.com' },
        { redirectUri: fixture.context.audience + '/different-callback' },
        { state: 'z'.repeat(43) },
        { bootstrapTicket: 'y'.repeat(43) },
        { accessTokenHash: 'x'.repeat(43) },
    ])('rejects substitution of context %j', async (override) => {
        expect(
            await verifyBrowserSsoBootstrapReceipt(
                fixture.keyMaterial,
                { ...fixture.context, ...override },
                fixture.receipt,
            ),
        ).toBe(false);
    });
    it.each(['', 'invalid', 'a'.repeat(43), 'A'.repeat(42) + 'B', 'A'.repeat(44)])(
        'rejects malformed or forged receipt %s',
        async (receipt) => {
            expect(
                await verifyBrowserSsoBootstrapReceipt(
                    fixture.keyMaterial,
                    fixture.context,
                    receipt,
                ),
            ).toBe(false);
        },
    );
    it('rejects a different app key and malformed signing context', async () => {
        expect(
            await verifyBrowserSsoBootstrapReceipt(
                'other-synthetic-jwt-secret-0123456789',
                fixture.context,
                fixture.receipt,
            ),
        ).toBe(false);
        await expect(createBrowserSsoBootstrapReceipt('short', fixture.context)).rejects.toThrow();
        await expect(
            createBrowserSsoBootstrapReceipt(fixture.keyMaterial, {
                ...fixture.context,
                bootstrapTicket: 'bad',
            }),
        ).rejects.toThrow();
    });
});
