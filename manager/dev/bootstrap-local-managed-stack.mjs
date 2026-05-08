// SPDX-License-Identifier: GPL-3.0-or-later

import { dirname, join } from 'node:path';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import {
    applyManagerState,
    buildRuntimePlan,
    loadManagerRuntimeSettings,
    loadManagerStateOrEmpty,
    resetManagerStateApplyMetadata,
    saveManagerState,
} from '../dist/index.js';

const scriptDirectory = dirname(fileURLToPath(import.meta.url));
const managerDirectory = dirname(scriptDirectory);
const runtimeDirectory = join(managerDirectory, 'runtime');
const managerConfigPath =
    process.env.MAGICSSO_MANAGER_CONFIG_FILE ?? join(runtimeDirectory, 'manager.toml');
const managerStatePath = join(runtimeDirectory, 'manager-state.json');

function writeStateIfMissing(templatePath, outputPath) {
    if (existsSync(outputPath)) {
        return;
    }

    const template = readFileSync(templatePath, 'utf8');
    const rendered = template.replaceAll(/\$\{([A-Z0-9_]+)\}/g, (_match, key) => {
        const value = process.env[key];
        if (typeof value !== 'string' || value.length === 0) {
            throw new Error(`Missing required env var for local manager bootstrap: ${key}`);
        }

        return value;
    });
    writeFileSync(outputPath, rendered, 'utf8');
}

writeStateIfMissing(join(scriptDirectory, 'manager-state.json.template'), managerStatePath);

const settings = loadManagerRuntimeSettings({
    configFilePath: managerConfigPath,
});
const state = loadManagerStateOrEmpty(settings);
const currentRuntimePlan = buildRuntimePlan(state, settings);
const baseConfigChangedFromTemplate =
    typeof state.metadata.lastAppliedBaseConfigHash === 'string' &&
    state.metadata.lastAppliedBaseConfigHash !== currentRuntimePlan.baseConfigHash;
const bootstrapState = baseConfigChangedFromTemplate
    ? resetManagerStateApplyMetadata(state)
    : state;

if (baseConfigChangedFromTemplate) {
    saveManagerState(settings.paths.stateFile, bootstrapState);
}

await applyManagerState(bootstrapState, {
    ...settings,
    reload: undefined,
});
