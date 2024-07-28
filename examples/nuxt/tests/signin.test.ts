// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Wojciech Polak

import { describe, expect, it } from 'vitest';
import { buildFailureResult, readMessage, readServerUrlConfigError } from '../server/api/signin';
import { readFile } from 'node:fs/promises';
import path from 'node:path';

describe('Nuxt sign-in helpers', () => {
    it('reads a string message from object payloads', () => {
        expect(readMessage({ message: 'Invalid or untrusted verify URL' })).toBe(
            'Invalid or untrusted verify URL',
        );
    });

    it('returns null for payloads without a usable message', () => {
        expect(readMessage({ message: '' })).toBeNull();
        expect(readMessage({ reason: 'bad request' })).toBeNull();
        expect(readMessage('plain text')).toBeNull();
    });

    it('builds a failure result using the upstream message when present', () => {
        expect(buildFailureResult({ message: 'Invalid or untrusted verify URL' })).toEqual({
            message: 'Invalid or untrusted verify URL',
        });
    });

    it('falls back to the generic message when no upstream message exists', () => {
        expect(buildFailureResult({})).toEqual({
            message: 'Failed to send verification email.',
        });
    });

    it('returns a clear error when the server url points back to the Nuxt app', () => {
        expect(readServerUrlConfigError('http://localhost:3002', 'http://localhost:3002')).toBe(
            'MAGICSSO_SERVER_URL points to this Nuxt app. Set it to the Magic Link SSO server, usually http://localhost:3000 for local development.',
        );
    });

    it('returns a clear error when the server url is not an absolute url', () => {
        expect(readServerUrlConfigError('/signin', 'http://localhost:3002')).toBe(
            'MAGICSSO_SERVER_URL must be an absolute URL.',
        );
    });

    it('accepts a server url on a different origin', () => {
        expect(
            readServerUrlConfigError('http://localhost:3000', 'http://localhost:3002'),
        ).toBeNull();
    });

    it('sign-in route falls back to process env for the server URL', async () => {
        const routePath = path.join(process.cwd(), 'server/api/signin.post.ts');
        const routeSource = await readFile(routePath, 'utf8');

        expect(routeSource).toContain('process.env.MAGICSSO_SERVER_URL');
        expect(routeSource).toContain('process.env.APP_URL');
        expect(routeSource).toContain('readServerUrlConfigError');
    });
});
