// SPDX-License-Identifier: MIT
import { describe, expect, it } from 'vitest';
import { renderMailbox } from '../src/mailbox.mjs';

describe('development mailbox', () => {
    it('shows an empty inbox with a refresh action', (): void => {
        expect(renderMailbox([])).toContain('No messages yet');
        expect(renderMailbox([])).toContain('href="/"');
    });

    it('shows newest mail first, escapes content and links to the exact magic URL', (): void => {
        const html = renderMailbox([
            { subject: 'older', to: ['owner@example.com'], text: 'first' },
            {
                subject: '<script>bad()</script>',
                to: ['<user@example.com>'],
                text: 'OTP 123456\nhttp://127.0.0.1:46000/sso/verify?requestId=abc&token=xyz\n<img onerror="bad()">',
            },
        ]);
        expect(html.indexOf('&lt;script&gt;')).toBeLessThan(html.indexOf('older'));
        expect(html).not.toContain('<script>');
        expect(html).not.toContain('<img');
        expect(html).toContain('OTP 123456');
        expect(html).toContain(
            'href="http://127.0.0.1:46000/sso/verify?requestId=abc&amp;token=xyz"',
        );
        expect(html).toContain('&lt;user@example.com&gt;');
    });
});
