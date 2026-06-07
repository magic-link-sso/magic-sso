import { describe, expect, it } from 'vitest';
import { escapeHtml, readCookieValue, safeCompare } from './runtime.js';

describe('runtime helpers', () => {
    it('returns the first matching cookie value by default', () => {
        expect(readCookieValue('magic-sso=first; theme=dark; magic-sso=last', 'magic-sso')).toBe(
            'first',
        );
    });

    it('can return the last matching cookie value when requested', () => {
        expect(
            readCookieValue('magic-sso=first; theme=dark; magic-sso=last', 'magic-sso', {
                lastMatch: true,
            }),
        ).toBe('last');
    });

    it('decodes cookie values and falls back to the raw value on invalid encoding', () => {
        expect(readCookieValue('magic-sso=hello%20world', 'magic-sso')).toBe('hello world');
        expect(readCookieValue('magic-sso=100%broken', 'magic-sso')).toBe('100%broken');
    });

    it('compares string values in constant time after checking their lengths', () => {
        expect(safeCompare('token', 'token')).toBe(true);
        expect(safeCompare('token', 'other')).toBe(false);
        expect(safeCompare('token', 'tokens')).toBe(false);
    });

    it('escapes HTML-sensitive characters', () => {
        expect(escapeHtml(`<a href="test">it's & safe</a>`)).toBe(
            '&lt;a href=&quot;test&quot;&gt;it&#39;s &amp; safe&lt;/a&gt;',
        );
    });
});
