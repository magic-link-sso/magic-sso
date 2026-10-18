// SPDX-License-Identifier: MIT
import { expect, it } from 'vitest';
import {
    isBrowserSsoOpaqueValue,
    isBrowserSsoCodeVerifier,
    isBrowserSsoInteger,
    isBrowserSsoTimestamp,
} from './browser-sso-validation.js';

it('rejects malformed opaque values and PKCE verifiers', () => {
    expect(isBrowserSsoOpaqueValue('a'.repeat(43))).toBe(true);
    for (const value of [null, 43, '', 'a'.repeat(42), '+'.repeat(43)]) {
        expect(isBrowserSsoOpaqueValue(value)).toBe(false);
    }
    expect(isBrowserSsoCodeVerifier('a'.repeat(43) + '.~-_')).toBe(true);
    for (const value of [null, '', 'a'.repeat(129), '+'.repeat(43)]) {
        expect(isBrowserSsoCodeVerifier(value)).toBe(false);
    }
});

it('retains strict integer bounds and safe timestamp validation', () => {
    expect(isBrowserSsoInteger(60, 60, 120)).toBe(true);
    expect(isBrowserSsoInteger(120, 60, 120)).toBe(true);
    for (const value of ['60', NaN, Infinity, 59, 121, 60.5]) {
        expect(isBrowserSsoInteger(value, 60, 120)).toBe(false);
    }
    expect(isBrowserSsoTimestamp(0)).toBe(true);
    expect(isBrowserSsoTimestamp(Number.MAX_SAFE_INTEGER)).toBe(true);
    for (const value of [null, -1, 0.5, Number.MAX_SAFE_INTEGER + 1, Infinity]) {
        expect(isBrowserSsoTimestamp(value)).toBe(false);
    }
});
