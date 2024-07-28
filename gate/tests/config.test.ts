// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Wojciech Polak

import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
    buildGatePath,
    collectGateTargetWarnings,
    loadConfig,
    normaliseReturnUrl,
    resolveGateConfig,
    readConfigFilePath,
    stripPublicPathPrefix,
} from '../src/config.js';

const TEST_JWT_SECRET = 'test-jwt-secret-for-magic-gate-123456';
const TEST_PREVIEW_SECRET = 'test-preview-secret-for-magic-gate-123';

function createTempConfigFile(contents: string): {
    cleanup: () => void;
    path: string;
} {
    const dir = mkdtempSync(join(tmpdir(), 'magic-gate-config-'));
    const path = join(dir, 'magic-gate.toml');
    writeFileSync(path, contents, 'utf8');

    return {
        cleanup: () => {
            rmSync(dir, { force: true, recursive: true });
        },
        path,
    };
}

function baseToml(overrides: string = ''): string {
    return `
[gate]
port = 43106
mode = "subdomain"
namespace = "/_magicgate"
publicOrigin = "http://private.example.com"
upstreamUrl = "http://private-upstream.internal"
requestTimeoutMs = 10000
rateLimitMax = 240
rateLimitKeyPrefix = "magic-sso-gate-test"
rateLimitRedisUrl = "redis://127.0.0.1:6379/0"
rateLimitWindowMs = 60000
trustProxy = false
directUse = false
upstreamBasePath = ""
wsEnabled = true

[auth]
jwtSecret = "test-jwt-secret-for-magic-gate-123456"
previewSecret = "test-preview-secret-for-magic-gate-123"
serverUrl = "http://sso.example.com"

[cookie]
name = "magic-sso"
path = "/"
maxAge = 3600
${overrides}`.trimStart();
}

describe('gate config helpers', () => {
    it('builds namespaced routes in subdomain mode', () => {
        const config = resolveGateConfig({
            jwtSecret: TEST_JWT_SECRET,
            port: 4000,
            publicOrigin: 'https://private.example.com',
            previewSecret: TEST_PREVIEW_SECRET,
            serverUrl: 'https://sso.example.com',
            upstreamUrl: 'http://upstream.internal',
        });

        expect(config.port).toBe(4000);
        expect(config.namespaceRoot).toBe('/_magicgate');
        expect(buildGatePath(config, '/login')).toBe('/_magicgate/login');
        expect(normaliseReturnUrl('/dashboard', config)).toBe(
            'https://private.example.com/dashboard',
        );
    });

    it('enforces the path prefix in path-prefix mode', () => {
        const config = resolveGateConfig({
            jwtSecret: TEST_JWT_SECRET,
            port: 4000,
            mode: 'path-prefix',
            publicOrigin: 'https://private.example.com',
            publicPathPrefix: '/private',
            previewSecret: TEST_PREVIEW_SECRET,
            serverUrl: 'https://sso.example.com',
            upstreamUrl: 'http://upstream.internal',
        });

        expect(config.port).toBe(4000);
        expect(config.namespaceRoot).toBe('/private/_magicgate');
        expect(stripPublicPathPrefix('/private/dashboard', config)).toBe('/dashboard');
        expect(stripPublicPathPrefix('/public', config)).toBeNull();
        expect(normaliseReturnUrl('/elsewhere', config)).toBe(
            'https://private.example.com/private/',
        );
        expect(normaliseReturnUrl('/private/area', config)).toBe(
            'https://private.example.com/private/area',
        );
    });

    it('rejects invalid namespaces', () => {
        expect(() =>
            resolveGateConfig({
                jwtSecret: TEST_JWT_SECRET,
                port: 4000,
                namespace: '/',
                publicOrigin: 'https://private.example.com',
                previewSecret: TEST_PREVIEW_SECRET,
                serverUrl: 'https://sso.example.com',
                upstreamUrl: 'http://upstream.internal',
            }),
        ).toThrow('gate.namespace cannot be "/"');
    });

    it('rejects short jwt secrets', () => {
        expect(() =>
            resolveGateConfig({
                jwtSecret: 'short-secret',
                port: 4000,
                publicOrigin: 'https://private.example.com',
                previewSecret: TEST_PREVIEW_SECRET,
                serverUrl: 'https://sso.example.com',
                upstreamUrl: 'http://upstream.internal',
            }),
        ).toThrow('auth.jwtSecret must be at least 32 characters long.');
    });

    it('rejects placeholder jwt secrets', () => {
        expect(() =>
            resolveGateConfig({
                jwtSecret: 'replace-with-a-real-jwt-secret-at-least-32-chars',
                port: 4000,
                publicOrigin: 'https://private.example.com',
                previewSecret: TEST_PREVIEW_SECRET,
                serverUrl: 'https://sso.example.com',
                upstreamUrl: 'http://upstream.internal',
            }),
        ).toThrow('auth.jwtSecret must be replaced with a real secret value.');
    });

    it('rejects placeholder preview secrets', () => {
        expect(() =>
            resolveGateConfig({
                jwtSecret: TEST_JWT_SECRET,
                port: 4000,
                publicOrigin: 'https://private.example.com',
                previewSecret: 'replace-with-a-real-preview-secret-at-least-32-chars',
                serverUrl: 'https://sso.example.com',
                upstreamUrl: 'http://upstream.internal',
            }),
        ).toThrow('auth.previewSecret must be replaced with a real secret value.');
    });

    it('warns when gate targets use private or metadata-adjacent hosts', () => {
        const config = resolveGateConfig({
            jwtSecret: TEST_JWT_SECRET,
            port: 4000,
            publicOrigin: 'https://private.example.com',
            previewSecret: TEST_PREVIEW_SECRET,
            serverUrl: 'http://169.254.169.254',
            upstreamUrl: 'http://127.0.0.1',
        });

        expect(collectGateTargetWarnings(config)).toEqual([
            {
                fieldName: 'auth.serverUrl',
                hostname: '169.254.169.254',
                reason: 'link-local or metadata-service IPv4 target',
                url: 'http://169.254.169.254',
            },
            {
                fieldName: 'gate.upstreamUrl',
                hostname: '127.0.0.1',
                reason: 'private or loopback IPv4 target',
                url: 'http://127.0.0.1',
            },
        ]);
    });

    it('does not warn for public gate targets', () => {
        const config = resolveGateConfig({
            jwtSecret: TEST_JWT_SECRET,
            port: 4000,
            publicOrigin: 'https://private.example.com',
            previewSecret: TEST_PREVIEW_SECRET,
            serverUrl: 'https://sso.example.com',
            upstreamUrl: 'https://app.example.com',
        });

        expect(collectGateTargetWarnings(config)).toEqual([]);
    });
});

describe('gate TOML loader', () => {
    it('loads a valid TOML config file', () => {
        const file = createTempConfigFile(baseToml());

        try {
            const config = loadConfig({
                MAGIC_GATE_CONFIG_FILE: file.path,
            });

            expect(config.port).toBe(43106);
            expect(config.cookieName).toBe('magic-sso');
            expect(config.cookieMaxAge).toBe(3600);
            expect(config.publicOrigin).toBe('http://private.example.com');
            expect(config.rateLimitKeyPrefix).toBe('magic-sso-gate-test');
            expect(config.rateLimitRedisUrl).toBe('redis://127.0.0.1:6379/0');
            expect(config.serverUrl).toBe('http://sso.example.com');
            expect(config.upstreamUrl).toBe('http://private-upstream.internal');
            expect(config.namespaceRoot).toBe('/_magicgate');
        } finally {
            file.cleanup();
        }
    });

    it('fails fast when MAGIC_GATE_CONFIG_FILE is missing', () => {
        expect(() => loadConfig({})).toThrowError(
            'MAGIC_GATE_CONFIG_FILE must point to a TOML config file.',
        );
    });

    it('fails fast when the config file cannot be read', () => {
        expect(() =>
            loadConfig({
                MAGIC_GATE_CONFIG_FILE: '/tmp/does-not-exist-magic-gate.toml',
            }),
        ).toThrowError(/Failed to read MAGIC_GATE_CONFIG_FILE/u);
    });

    it('fails fast when the TOML is invalid', () => {
        const file = createTempConfigFile('[[gate]\nport = 4000\n');

        try {
            expect(() =>
                loadConfig({
                    MAGIC_GATE_CONFIG_FILE: file.path,
                }),
            ).toThrowError(/Failed to parse MAGIC_GATE_CONFIG_FILE/u);
        } finally {
            file.cleanup();
        }
    });

    it('fails fast when required gate settings are missing', () => {
        const file = createTempConfigFile(
            `
[gate]
port = 43106
publicOrigin = "http://private.example.com"
upstreamUrl = "http://private-upstream.internal"

[auth]
serverUrl = "http://sso.example.com"
`.trimStart(),
        );

        try {
            expect(() =>
                loadConfig({
                    MAGIC_GATE_CONFIG_FILE: file.path,
                }),
            ).toThrowError(/Failed to validate MAGIC_GATE_CONFIG_FILE/u);
        } finally {
            file.cleanup();
        }
    });

    it('reads the config file path from the environment', () => {
        expect(readConfigFilePath({ MAGIC_GATE_CONFIG_FILE: '/tmp/magic-gate.toml' })).toBe(
            '/tmp/magic-gate.toml',
        );
    });

    it('rejects non-Redis rate limit URLs', () => {
        const file = createTempConfigFile(
            baseToml().replace(
                'rateLimitRedisUrl = "redis://127.0.0.1:6379/0"',
                'rateLimitRedisUrl = "https://redis.example.com"',
            ),
        );

        try {
            expect(() =>
                loadConfig({
                    MAGIC_GATE_CONFIG_FILE: file.path,
                }),
            ).toThrowError('gate.rateLimitRedisUrl must use the redis:// or rediss:// protocol.');
        } finally {
            file.cleanup();
        }
    });
});
