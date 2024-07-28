// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Wojciech Polak

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

function readGateFile(pathname: string): string {
    return readFileSync(join(import.meta.dirname, '..', pathname), 'utf8');
}

describe('gate dev bootstrap template', () => {
    it('uses server-prefixed auth render variables for the SSO template', () => {
        const template = readGateFile('dev/magic-sso.toml.template');

        expect(template).toContain('MAGICSSO_JWT_SECRET');
        expect(template).toContain('MAGICSSO_PREVIEW_SECRET');
        expect(template).toContain('MAGICSSO_DEV_CSRF_SECRET');
        expect(template).toContain('MAGICSSO_DEV_EMAIL_SECRET');
        expect(template).not.toContain('MAGIC_GATE_RENDER_PREVIEW_SECRET');
    });

    it('uses gate-prefixed auth render variables', () => {
        const template = readGateFile('dev/magic-gate.toml.template');

        expect(template).toContain('MAGIC_GATE_RENDER_JWT_SECRET');
        expect(template).toContain('MAGIC_GATE_RENDER_PREVIEW_SECRET');
        expect(template).toContain('MAGIC_GATE_RENDER_SERVER_URL');
        expect(template).toContain('MAGIC_GATE_RENDER_COOKIE_NAME');
        expect(template).toContain('MAGIC_GATE_RENDER_COOKIE_MAX_AGE');
        expect(template).not.toContain('MAGICSSO_JWT_SECRET');
        expect(template).not.toContain('MAGICSSO_PREVIEW_SECRET');
        expect(template).not.toContain('MAGICSSO_SERVER_URL');
        expect(template).not.toContain('MAGICSSO_COOKIE_NAME');
        expect(template).not.toContain('MAGICSSO_COOKIE_MAX_AGE');
    });

    it('passes the gate auth render values through compose', () => {
        const compose = readGateFile('docker-compose.yml');

        expect(compose).toContain('MAGIC_GATE_RENDER_JWT_SECRET');
        expect(compose).toContain('MAGIC_GATE_RENDER_PREVIEW_SECRET');
        expect(compose).toContain('MAGIC_GATE_RENDER_SERVER_URL');
        expect(compose).toContain('MAGIC_GATE_RENDER_COOKIE_NAME');
        expect(compose).toContain('MAGIC_GATE_RENDER_COOKIE_MAX_AGE');
    });

    it('does not advertise the removed SSE config flag', () => {
        const exampleEnv = readGateFile('.env.example');
        const exampleToml = readGateFile('magic-gate.example.toml');

        expect(exampleEnv).not.toContain('MAGIC_GATE_RENDER_SSE_ENABLED');
        expect(exampleToml).not.toContain('sseEnabled');
    });
});
