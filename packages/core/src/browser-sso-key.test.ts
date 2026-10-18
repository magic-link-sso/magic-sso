// SPDX-License-Identifier: MIT
import { expect, it } from 'vitest';
import { deriveBrowserSsoKey } from './browser-sso-key.js';

it('keeps protocol purposes and issuers cryptographically separate', async () => {
    const secret = 'shared-key-material-01234567890123456789';
    const key = await deriveBrowserSsoKey(
        secret,
        'https://issuer.test',
        'receipt',
        { name: 'HMAC', hash: 'SHA-256', length: 256 },
        ['sign', 'verify'],
    );
    const message = new TextEncoder().encode('completion');
    const signature = await crypto.subtle.sign('HMAC', key, message);
    const same = await deriveBrowserSsoKey(
        secret,
        'https://issuer.test',
        'receipt',
        { name: 'HMAC', hash: 'SHA-256', length: 256 },
        ['verify'],
    );
    expect(await crypto.subtle.verify('HMAC', same, signature, message)).toBe(true);
    for (const [issuer, purpose] of [
        ['https://issuer.test', 'transaction'],
        ['https://other.test', 'receipt'],
    ]) {
        const other = await deriveBrowserSsoKey(
            secret,
            issuer ?? '',
            purpose ?? '',
            { name: 'HMAC', hash: 'SHA-256', length: 256 },
            ['verify'],
        );
        expect(await crypto.subtle.verify('HMAC', other, signature, message)).toBe(false);
    }
    expect(key.extractable).toBe(false);
});
