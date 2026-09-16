// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Wojciech Polak

import { describe, expect, it } from 'vitest';
import {
    isVerifyEmailPreviewResponse,
    isVerifyEmailResponse,
    parseBooleanFlag,
} from '../src/index.js';

describe('parseBooleanFlag', () => {
    it.each([
        [true, false, true],
        [false, true, false],
        [' YES ', false, true],
        ['on', false, true],
        ['0', true, false],
        ['Off', true, false],
        ['maybe', true, true],
        [undefined, false, false],
        [1, true, true],
    ])('parses %j with fallback %j as %j', (value, fallback, expected) => {
        expect(parseBooleanFlag(value, fallback)).toBe(expected);
    });

    it('defaults the fallback to false', () => {
        expect(parseBooleanFlag('unknown')).toBe(false);
    });
});

describe('verify-email response guards', () => {
    it('accepts a non-empty access token', () => {
        expect(isVerifyEmailResponse({ accessToken: 'token' })).toBe(true);
    });

    it.each([null, 'token', {}, { accessToken: 42 }, { accessToken: '' }])(
        'rejects %j as a verify-email response',
        (value) => {
            expect(isVerifyEmailResponse(value)).toBe(false);
        },
    );

    it('accepts a non-empty preview email', () => {
        expect(isVerifyEmailPreviewResponse({ email: 'user@example.com' })).toBe(true);
    });

    it.each([null, 'user@example.com', {}, { email: 42 }, { email: '' }])(
        'rejects %j as a verify-email preview response',
        (value) => {
            expect(isVerifyEmailPreviewResponse(value)).toBe(false);
        },
    );
});
