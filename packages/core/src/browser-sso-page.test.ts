// SPDX-License-Identifier: MIT
import { describe, expect, it } from 'vitest';
import {
    getBrowserSsoErrorMessage,
    getBrowserSsoPageHeaders,
    renderBrowserSsoStatusPage,
} from './browser-sso-page.js';

describe('browser SSO default status pages', () => {
    it('escapes content, offers only explicit links, and prevents scripts or caching', () => {
        const html = renderBrowserSsoStatusPage({
            title: '<script>bad</script>',
            message: '<img onerror=bad>',
            nextHref: 'https://app.example.com/?q="bad"',
            nextText: 'Return <here>',
            centralSignOutHref: 'https://sso.example.com/sso/signout',
            isError: true,
        });
        expect(html).not.toContain('<script>');
        expect(html).not.toContain('<img');
        expect(html).toContain('role="alert"');
        expect(html).toContain('End browser SSO session');
        expect(html).toContain('&quot;bad&quot;');
        expect(getBrowserSsoPageHeaders()).toMatchObject({
            'cache-control': 'no-store',
            'referrer-policy': 'no-referrer',
        });
        expect(getBrowserSsoPageHeaders()['content-security-policy']).toContain(
            "script-src 'none'",
        );
        expect(getBrowserSsoErrorMessage('transaction_limit')).toContain('another tab');
    });
});
