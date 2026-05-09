import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { createE2eConfig, createManagerE2eConfig } from '../playwright.base.js';

function collectGateConfigFiles(config: ReturnType<typeof createE2eConfig>): readonly string[] {
    const webServers = Array.isArray(config.webServer)
        ? config.webServer
        : typeof config.webServer === 'undefined'
          ? []
          : [config.webServer];

    return webServers.flatMap((server) => {
        const filePath = server.env?.MAGIC_GATE_CONFIG_FILE;
        return typeof filePath === 'string' ? [filePath] : [];
    });
}

function collectManagerConfigFiles(
    config: ReturnType<typeof createManagerE2eConfig>,
): readonly string[] {
    const webServers = Array.isArray(config.webServer)
        ? config.webServer
        : typeof config.webServer === 'undefined'
          ? []
          : [config.webServer];

    return webServers.flatMap((server) => {
        const filePath = server.env?.MAGICSSO_MANAGER_CONFIG_FILE;
        return typeof filePath === 'string' ? [filePath] : [];
    });
}

function collectManagerConfigFilesByServer(config: ReturnType<typeof createManagerE2eConfig>): {
    bootstrapConfigFile: string | undefined;
    serviceConfigFile: string | undefined;
} {
    const webServers = Array.isArray(config.webServer)
        ? config.webServer
        : typeof config.webServer === 'undefined'
          ? []
          : [config.webServer];

    return {
        bootstrapConfigFile: webServers.find(
            (server) =>
                server.env?.WEB_SERVER_COMMAND?.includes('pnpm --filter magic-sso-server start') ??
                false,
        )?.env?.MAGICSSO_MANAGER_CONFIG_FILE,
        serviceConfigFile: webServers.find(
            (server) =>
                server.env?.WEB_SERVER_COMMAND?.includes('pnpm --filter magic-sso-manager start') ??
                false,
        )?.env?.MAGICSSO_MANAGER_CONFIG_FILE,
    };
}

describe('playwright base config', () => {
    it('writes directUse into the gate TOML as a boolean', () => {
        const config = createE2eConfig({
            directUse: false,
            testMatch: /example-apps-magic-link\.indirect\.spec\.ts/u,
        });

        for (const filePath of collectGateConfigFiles(config)) {
            const contents = readFileSync(filePath, 'utf8');
            expect(contents).toContain('directUse = false');
            expect(contents).not.toContain('directUse = true');
        }
    });

    it('writes a dedicated manager stack with Gate auth and runtime apply wiring', () => {
        const config = createManagerE2eConfig();
        expect(collectManagerConfigFiles(config)).toHaveLength(2);

        const { bootstrapConfigFile, serviceConfigFile } =
            collectManagerConfigFilesByServer(config);
        expect(bootstrapConfigFile).toBeDefined();
        expect(serviceConfigFile).toBeDefined();
        if (typeof bootstrapConfigFile !== 'string' || typeof serviceConfigFile !== 'string') {
            throw new Error('Manager config files were not attached to the expected web servers.');
        }

        const bootstrapContents = readFileSync(bootstrapConfigFile, 'utf8');
        expect(bootstrapContents).toContain('managedSiteIds = ["photos"]');
        expect(bootstrapContents).not.toContain('[reload]');
        expect(bootstrapContents).not.toContain('[service]');
        const baseConfigPathMatch = bootstrapContents.match(/^baseConfigFile = "(.+)"$/mu);
        expect(baseConfigPathMatch?.[1]).toBeDefined();
        if (typeof baseConfigPathMatch?.[1] !== 'string') {
            throw new Error('Bootstrap config did not include a baseConfigFile path.');
        }
        const baseConfigContents = readFileSync(baseConfigPathMatch[1], 'utf8');
        expect(baseConfigContents).toContain(
            'allowedEmails = ["owner@example.com", "friend@example.com", "family@example.com"]',
        );

        const serviceContents = readFileSync(serviceConfigFile, 'utf8');
        expect(serviceContents).toContain('managedSiteIds = ["photos"]');
        expect(serviceContents).toContain('requiredSiteId = "manager-admin"');
        expect(serviceContents).toContain('requiredScope = "*"');
        expect(serviceContents).toContain('/internal/access-config/reload');

        const webServers = Array.isArray(config.webServer) ? config.webServer : [];
        expect(webServers.some((server) => server.url === 'http://127.0.0.1:43110/healthz')).toBe(
            true,
        );
        expect(
            webServers.some((server) => server.url === 'http://localhost:43111/_magicgate/healthz'),
        ).toBe(true);
        expect(
            webServers.some((server) =>
                server.env?.WEB_SERVER_COMMAND?.includes('node manager/dist/cli.js apply --yes'),
            ),
        ).toBe(true);
        expect(webServers.some((server) => server.url === 'http://localhost:5001/login')).toBe(
            true,
        );
    });
});
