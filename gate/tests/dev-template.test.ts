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
        expect(template).toContain('secret = "${MANAGER_RELOAD_SECRET}"');
        expect(template).toContain('id = "manager-admin"');
        expect(template).toContain('MANAGER_PUBLIC_HOST');
        expect(template).toContain('MANAGER_ALLOWED_EMAIL');
        expect(template).toContain('PRIVATE1_ALLOWED_EMAIL');
        expect(template).toContain('PRIVATE2_ALLOWED_EMAIL');
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

    it('uses a dedicated manager template and managed-site seed state', () => {
        const managerTemplate = readGateFile('dev/manager.toml.template');
        const managerStateTemplate = readGateFile('dev/manager-state.json.template');
        const bootstrapScript = readGateFile('dev/bootstrap-manager-stack.mjs');

        expect(managerTemplate).toContain('managedSiteIds = ["private1", "private2"]');
        expect(managerTemplate).toContain('integrityKey = "${MANAGER_AUDIT_INTEGRITY_KEY}"');
        expect(managerTemplate).toContain(
            'url = "http://magic-sso:3000/internal/access-config/reload"',
        );
        expect(managerTemplate).toContain('mode = "gate"');
        expect(managerTemplate).toContain('requiredSiteId = "manager-admin"');
        expect(managerTemplate).toContain('trustProxy = true');
        expect(managerStateTemplate).toContain('PRIVATE1_ALLOWED_EMAIL');
        expect(managerStateTemplate).toContain('PRIVATE2_ALLOWED_EMAIL');
        expect(bootstrapScript).toContain('applyManagerState');
        expect(bootstrapScript).toContain('reload: undefined');
        expect(bootstrapScript).toContain('resetManagerStateApplyMetadata');
    });

    it('passes the gate auth render values through compose', () => {
        const compose = readGateFile('docker-compose.yml');

        expect(compose).toContain('MAGIC_GATE_RENDER_JWT_SECRET');
        expect(compose).toContain('MAGIC_GATE_RENDER_PREVIEW_SECRET');
        expect(compose).toContain('MAGIC_GATE_RENDER_SERVER_URL');
        expect(compose).toContain('MAGIC_GATE_RENDER_COOKIE_NAME');
        expect(compose).toContain('MAGIC_GATE_RENDER_COOKIE_MAX_AGE');
        expect(compose).toContain('magic-gate-manager');
        expect(compose).toContain('./runtime:/app/runtime');
        expect(compose).toContain('./runtime:/app/runtime:ro');
        expect(compose).toContain('MANAGER_AUDIT_INTEGRITY_KEY');
        expect(compose).toContain('MANAGER_RELOAD_SECRET');
        expect(compose).toContain('MANAGER_PUBLIC_HOST');
        expect(compose).toContain('MANAGER_UPSTREAM_PORT');
        expect(compose).toContain('start_interval: 5s');
        expect(compose).toContain("fetch('http://127.0.0.1:4311/healthz')");
        expect(compose).not.toContain('- magic-gate-manager');
    });

    it('does not advertise the removed SSE config flag', () => {
        const exampleEnv = readGateFile('.env.example');
        const exampleToml = readGateFile('magic-gate.example.toml');

        expect(exampleEnv).toContain('MANAGER_PUBLIC_HOST=manager.localhost');
        expect(exampleEnv).toContain('MANAGER_ALLOWED_EMAIL=manager@example.com');
        expect(exampleEnv).toContain('MANAGER_AUDIT_INTEGRITY_KEY=');
        expect(exampleEnv).toContain('MANAGER_RELOAD_SECRET=');
        expect(exampleEnv).not.toContain('MAGIC_GATE_RENDER_SSE_ENABLED');
        expect(exampleToml).not.toContain('sseEnabled');
    });
});
