// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Wojciech Polak

import { describe, expect, it } from 'vitest';
import { buildFailureResult, readMessage, readServerUrlConfigError } from '../src/signin-utils';

describe('Angular signin utilities', () => {
    it('reads a non-empty message field from payloads', () => {
        expect(readMessage({ message: 'Email blocked.' })).toBe('Email blocked.');
        expect(readMessage({ message: '' })).toBeNull();
        expect(readMessage(null)).toBeNull();
    });

    it('uses a fallback failure message when the payload has no message', () => {
        expect(buildFailureResult({ ok: false }).message).toBe(
            'Failed to send verification email.',
        );
        expect(buildFailureResult({ message: 'Denied.' }).message).toBe('Denied.');
    });

    it('flags a same-origin MAGICSSO_SERVER_URL as a local misconfiguration', () => {
        expect(readServerUrlConfigError('http://localhost:3004', 'http://localhost:3004')).toBe(
            'MAGICSSO_SERVER_URL points to this Angular app. Set it to the Magic Link SSO server, usually http://localhost:3000 for local development.',
        );
    });

    it('flags a non-absolute MAGICSSO_SERVER_URL', () => {
        expect(readServerUrlConfigError('/signin', 'http://localhost:3004')).toBe(
            'MAGICSSO_SERVER_URL must be an absolute URL.',
        );
    });

    it('accepts a valid external MAGICSSO_SERVER_URL', () => {
        expect(
            readServerUrlConfigError('http://localhost:3000', 'http://localhost:3004'),
        ).toBeNull();
    });
});
