// SPDX-License-Identifier: GPL-3.0-or-later
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, it } from 'vitest';
import { buildRuntimePlan } from './runtime.js';
import type { ManagerRuntimeSettings } from './settings.js';

it('preserves operator-owned SSO policy and exact registrations across managed grant changes', () => {
    const directory = mkdtempSync(join(tmpdir(), 'manager-browser-sso-'));
    const paths = {
        baseConfigFile: join(directory, 'base.toml'),
        stateFile: join(directory, 'state.json'),
        runtimeConfigFile: join(directory, 'runtime.toml'),
        lastGoodRuntimeConfigFile: join(directory, 'last-good.toml'),
        auditFile: join(directory, 'audit.ndjson'),
        lockFile: join(directory, 'manager.lock'),
    };
    const settings: ManagerRuntimeSettings = {
        configFilePath: join(directory, 'manager.toml'),
        managedSiteIds: ['app'],
        paths,
    };
    writeFileSync(
        paths.baseConfigFile,
        readFileSync(
            new URL('../../packages/config-core/src/browser-sso.fixture.toml', import.meta.url),
            'utf8',
        ) +
            '\n[sites.launcher]\nname = "Reports"\nlaunchUrl = "https://app.example.com/reports"\nscope = "reports"\n',
    );
    try {
        const plan = buildRuntimePlan(
            {
                version: 1,
                managedSites: {
                    app: {
                        scopeCatalog: ['reports'],
                        grants: [{ email: 'friend@example.com', scopes: ['reports'] }],
                    },
                },
                metadata: {},
            },
            settings,
        );
        expect(plan.runtimeConfig.auth.sso).toEqual(plan.baseConfig.auth.sso);
        expect(plan.runtimeConfig.sites[0]?.sso).toEqual(plan.baseConfig.sites[0]?.sso);
        expect(plan.runtimeConfig.sites[0]?.launcher).toEqual(plan.baseConfig.sites[0]?.launcher);
        expect(plan.validatedRuntimeConfig.sites[0]?.launcher).toEqual({
            name: 'Reports',
            launchUrl: 'https://app.example.com/reports',
            scope: 'reports',
        });
        expect(plan.validatedRuntimeConfig.sites[0]?.sso?.[0]?.signedOutUri).toBe(
            'https://app.example.com/signed-out',
        );
        expect(plan.validatedRuntimeConfig.sites[0]?.accessRules.get('friend@example.com')).toEqual(
            new Set(['reports']),
        );
    } finally {
        rmSync(directory, { recursive: true, force: true });
    }
});
