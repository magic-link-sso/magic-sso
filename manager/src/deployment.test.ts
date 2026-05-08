// SPDX-License-Identifier: GPL-3.0-or-later

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

function readManagerFile(pathname: string): string {
    return readFileSync(join(import.meta.dirname, '..', pathname), 'utf8');
}

describe('manager managed-mode deployment example', () => {
    it('keeps the stack file-backed and Gate-protected', () => {
        const compose = readManagerFile('docker-compose.yml');
        const caddyfile = readManagerFile('dev/Caddyfile');

        expect(compose).toContain('- ./runtime:/app/runtime');
        expect(compose).toContain('- ./runtime:/app/runtime:ro');
        expect(compose).toContain("- '${MAILPIT_SMTP_PORT:-1025}:1025'");
        expect(compose).toContain('dockerfile: manager/Dockerfile');
        expect(compose).toContain('dockerfile: server/Dockerfile');
        expect(compose).toContain('dockerfile: examples/photos/Dockerfile');
        expect(compose).toContain('dockerfile: gate/Dockerfile');
        expect(compose).toContain('image: caddy:2-alpine');
        expect(compose).toContain('public-proxy');
        expect(compose).toContain('MAGICSSO_CONFIG_FILE: /app/runtime/magic-sso.runtime.toml');
        expect(compose).toContain('MAGICSSO_MANAGER_CONFIG_FILE: /app/runtime/manager.toml');
        expect(compose).toContain(
            'MAGICSSO_PUBLIC_ORIGIN: http://${PHOTOS_PUBLIC_HOST:-photos.localhost}:${MANAGER_PUBLIC_PORT:-4306}',
        );
        expect(compose).toContain(
            'MAGICSSO_SERVER_URL: http://${SSO_PUBLIC_HOST:-sso.localhost}:${MANAGER_PUBLIC_PORT:-4306}',
        );
        expect(compose).toContain('PORT: 5001');
        expect(compose).toContain('MANAGER_PUBLIC_HOST');
        expect(compose).toContain('PHOTOS_PUBLIC_HOST');
        expect(compose).toContain('SSO_PUBLIC_HOST');
        expect(compose).toContain('MAGIC_GATE_RENDER_UPSTREAM_URL: http://manager:');
        expect(compose).toContain(
            'MAGIC_GATE_RENDER_PUBLIC_ORIGIN: http://${MANAGER_PUBLIC_HOST:-manager.localhost}:${MANAGER_PUBLIC_PORT:-4306}',
        );
        expect(compose).toContain(
            'MAGIC_GATE_RENDER_SERVER_URL: http://${SSO_PUBLIC_HOST:-sso.localhost}:${MANAGER_PUBLIC_PORT:-4306}',
        );
        expect(compose).toContain("- '${MANAGER_PUBLIC_PORT:-4306}:${MANAGER_PUBLIC_PORT:-4306}'");
        expect(compose).not.toContain("- '5001:5001'");
        expect(compose).not.toContain("- '${MANAGER_PUBLIC_PORT:-4306}:4000'");
        expect(compose).not.toContain('postgres');
        expect(compose).not.toContain('sqlite');
        expect(compose).not.toContain('redis:');
        expect(caddyfile).toContain('reverse_proxy magic-sso:3000');
        expect(caddyfile).toContain('reverse_proxy photos:5001');
        expect(caddyfile).toContain('reverse_proxy magic-gate-manager:4000');
    });

    it('renders dedicated manager bootstrap templates', () => {
        const baseConfigTemplate = readManagerFile('dev/magic-sso.base.toml.template');
        const localBaseConfigTemplate = readManagerFile('dev/magic-sso.base.local.toml.template');
        const managerConfigTemplate = readManagerFile('dev/manager.toml.template');
        const localManagerConfigTemplate = readManagerFile('dev/manager.local.toml.template');
        const managerStateTemplate = readManagerFile('dev/manager-state.json.template');
        const gateTemplate = readManagerFile('dev/magic-gate.toml.template');
        const localGateTemplate = readManagerFile('dev/magic-gate.local.toml.template');
        const bootstrapScript = readManagerFile('dev/bootstrap-managed-stack.mjs');
        const localBootstrapScript = readManagerFile('dev/bootstrap-local-managed-stack.mjs');

        expect(baseConfigTemplate).toContain('id = "manager-admin"');
        expect(baseConfigTemplate).toContain(
            'http://${MANAGER_PUBLIC_HOST}:${MANAGER_PUBLIC_PORT}',
        );
        expect(baseConfigTemplate).toContain('secret = "${MANAGER_RELOAD_SECRET}"');
        expect(baseConfigTemplate).toContain('id = "photos"');
        expect(baseConfigTemplate).toContain('http://${PHOTOS_PUBLIC_HOST}:${MANAGER_PUBLIC_PORT}');
        expect(baseConfigTemplate).toContain(
            'appUrl = "http://${SSO_PUBLIC_HOST}:${MANAGER_PUBLIC_PORT}"',
        );
        expect(baseConfigTemplate).toContain(
            'allowedEmails = ["${PHOTOS_OWNER_EMAIL}", "${PHOTOS_FRIEND_EMAIL}", "${PHOTOS_FAMILY_EMAIL}"]',
        );
        expect(localBaseConfigTemplate).toContain('appUrl = "${MANAGER_DEV_SERVER_ORIGIN}"');
        expect(localBaseConfigTemplate).toContain('host = "${MANAGER_DEV_SMTP_HOST}"');
        expect(localBaseConfigTemplate).toContain('${MANAGER_DEV_PHOTOS_ORIGIN}');
        expect(managerConfigTemplate).toContain('managedSiteIds = ["photos"]');
        expect(managerConfigTemplate).toContain('mode = "gate"');
        expect(managerConfigTemplate).toContain('requiredSiteId = "manager-admin"');
        expect(managerConfigTemplate).toContain('trustProxy = true');
        expect(managerConfigTemplate).toContain('integrityKey = "${MANAGER_AUDIT_INTEGRITY_KEY}"');
        expect(localManagerConfigTemplate).toContain('baseConfigFile = "./magic-sso.base.toml"');
        expect(localManagerConfigTemplate).toContain('trustProxy = true');
        expect(localManagerConfigTemplate).toContain(
            'integrityKey = "${MANAGER_AUDIT_INTEGRITY_KEY}"',
        );
        expect(localManagerConfigTemplate).toContain(
            'url = "${MANAGER_DEV_SERVER_ORIGIN}/internal/access-config/reload"',
        );
        expect(managerStateTemplate).toContain('${PHOTOS_OWNER_EMAIL}');
        expect(managerStateTemplate).toContain('photo:red-kite-at-dusk');
        expect(gateTemplate).toContain('serverUrl = "${MAGIC_GATE_RENDER_SERVER_URL}"');
        expect(gateTemplate).toContain('upstreamUrl = "${MAGIC_GATE_RENDER_UPSTREAM_URL}"');
        expect(localGateTemplate).toContain('port = ${MANAGER_PUBLIC_PORT}');
        expect(localGateTemplate).toContain('publicOrigin = "${MAGIC_GATE_RENDER_PUBLIC_ORIGIN}"');
        expect(bootstrapScript).toContain('applyManagerState');
        expect(bootstrapScript).toContain('buildRuntimePlan');
        expect(bootstrapScript).toContain('reload: undefined');
        expect(bootstrapScript).toContain('resetManagerStateApplyMetadata');
        expect(bootstrapScript).toContain('saveManagerState');
        expect(bootstrapScript).toContain(
            'lastAppliedBaseConfigHash !== currentRuntimePlan.baseConfigHash',
        );
        expect(localBootstrapScript).toContain('process.env.MAGICSSO_MANAGER_CONFIG_FILE');
        expect(localBootstrapScript).toContain('resetManagerStateApplyMetadata');
        expect(localBootstrapScript).toContain('reload: undefined');
    });

    it('ships a published-image production manager stack', () => {
        const productionCompose = readManagerFile('docker-compose.prod.yml');
        const productionEnv = readManagerFile('.env.prod.example');
        const productionManagerConfig = readManagerFile('manager.prod.example.toml');
        const productionGateConfig = readManagerFile('magic-gate.prod.example.toml');

        expect(productionCompose).toContain('ghcr.io/magic-link-sso/magic-sso/manager:latest');
        expect(productionCompose).toContain('ghcr.io/magic-link-sso/magic-sso/gate:latest');
        expect(productionCompose).toContain('- ./runtime:/app/runtime');
        expect(productionCompose).toContain('- ./magic-gate.toml:/app/gate/magic-gate.toml:ro');
        expect(productionCompose).toContain('MAGICSSO_MANAGER_CONFIG_FILE');
        expect(productionCompose).toContain('MAGIC_GATE_CONFIG_FILE');
        expect(productionCompose).toContain('condition: service_healthy');
        expect(productionCompose).not.toContain('build:');

        expect(productionEnv).toContain(
            'MANAGER_IMAGE=ghcr.io/magic-link-sso/magic-sso/manager:latest',
        );
        expect(productionEnv).toContain(
            'MAGIC_GATE_IMAGE=ghcr.io/magic-link-sso/magic-sso/gate:latest',
        );

        expect(productionManagerConfig).toContain('baseConfigFile = "./magic-sso.base.toml"');
        expect(productionManagerConfig).toContain('stateFile = "./manager-state.json"');
        expect(productionManagerConfig).toContain('runtimeConfigFile = "./magic-sso.runtime.toml"');
        expect(productionManagerConfig).toContain('host = "0.0.0.0"');
        expect(productionManagerConfig).toContain('mode = "gate"');
        expect(productionManagerConfig).toContain('requiredSiteId = "manager-admin"');

        expect(productionGateConfig).toContain('publicOrigin = "https://manager.example.com"');
        expect(productionGateConfig).toContain('upstreamUrl = "http://manager:4311"');
        expect(productionGateConfig).toContain('serverUrl = "https://sso.example.com"');
        expect(productionGateConfig).toContain('trustProxy = true');
    });
});
