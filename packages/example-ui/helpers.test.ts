// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Wojciech Polak

import { describe, expect, it } from 'vitest';
import { mergeEnvContent } from './env-file.js';
import { buildFailureResult, readMessage, readServerUrlConfigError } from './signin.js';

describe('mergeEnvContent', () => {
    const placeholders = new Map([['SECRET', new Set(['replace-me'])]]);

    it('returns the target unchanged when nothing needs merging', () => {
        const target = 'SECRET=custom\nPORT=3001\n';

        expect(mergeEnvContent('SECRET=generated\nPORT=3000\n', target, placeholders)).toBe(target);
    });

    it('refreshes placeholder values and appends missing keys', () => {
        const merged = mergeEnvContent(
            'SECRET=generated\nPORT=3000\nNEW_KEY=value\n',
            '# local overrides\nSECRET=replace-me\nPORT=3001',
            placeholders,
        );

        expect(merged).toBe('# local overrides\nSECRET=generated\nPORT=3001\nNEW_KEY=value\n');
    });

    it('keeps placeholder values that already match the example file', () => {
        const target = 'SECRET=replace-me\n';

        expect(mergeEnvContent('SECRET=replace-me\n', target, placeholders)).toBe(target);
    });
});

describe('sign-in response helpers', () => {
    it.each([
        [{ message: 'Check your inbox.' }, 'Check your inbox.'],
        [{ message: '' }, null],
        [{ message: 42 }, null],
        [null, null],
        ['message', null],
    ])('reads the message from %j', (value, expected) => {
        expect(readMessage(value)).toBe(expected);
    });

    it('prefers the server message and falls back otherwise', () => {
        expect(buildFailureResult({ message: 'Rate limited.' })).toEqual({
            message: 'Rate limited.',
        });
        expect(buildFailureResult({})).toEqual({ message: 'Failed to send verification email.' });
    });

    it('explains misconfigured server URLs', () => {
        expect(readServerUrlConfigError('not a url', 'http://localhost:3001', 'Nuxt')).toBe(
            'MAGICSSO_SERVER_URL must be an absolute URL.',
        );
        expect(
            readServerUrlConfigError('http://localhost:3001/', 'http://localhost:3001', 'Nuxt'),
        ).toContain('points to this Nuxt app');
        expect(
            readServerUrlConfigError('http://localhost:3000', 'http://localhost:3001', 'Nuxt'),
        ).toBeNull();
    });
});
