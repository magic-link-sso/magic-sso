import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { createE2eConfig } from '../playwright.base.js';

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
});
