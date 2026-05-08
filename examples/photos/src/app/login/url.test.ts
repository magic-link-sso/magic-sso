// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Wojciech Polak

import { describe, expect, it } from 'vitest';
import { getAppOrigin, resolveAppOrigin } from './url';

describe('login URL helpers', () => {
    it('infers localhost origins as http', () => {
        expect(getAppOrigin('localhost:5001')).toBe('http://localhost:5001');
    });

    it('uses forwarded proxy headers for the public app origin', () => {
        expect(
            resolveAppOrigin({
                fallbackOrigin: 'http://0.0.0.0:5001',
                forwardedHost: 'photos.localhost:4306',
                forwardedProtocol: 'http',
                host: '0.0.0.0:5001',
            }),
        ).toBe('http://photos.localhost:4306');
    });

    it('prefers the explicit public origin over forwarded headers', () => {
        expect(
            resolveAppOrigin({
                explicitPublicOrigin: 'http://photos.localhost:4306',
                fallbackOrigin: 'http://0.0.0.0:5001',
                forwardedHost: 'attacker.example.com',
                forwardedProtocol: 'https',
                host: '0.0.0.0:5001',
            }),
        ).toBe('http://photos.localhost:4306');
    });

    it('normalizes multi-value forwarded host headers', () => {
        expect(
            resolveAppOrigin({
                fallbackOrigin: 'http://0.0.0.0:5001',
                forwardedHost: 'photos.localhost:4306, internal.example:5001',
                forwardedProtocol: 'http',
            }),
        ).toBe('http://photos.localhost:4306');
    });

    it('falls back to the request origin when proxy headers are unavailable', () => {
        expect(
            resolveAppOrigin({
                fallbackOrigin: 'http://0.0.0.0:5001',
            }),
        ).toBe('http://0.0.0.0:5001');
    });
});
