// SPDX-License-Identifier: GPL-3.0-or-later

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import {
    applyManagerState,
    buildRuntimePlan,
    loadManagerRuntimeSettings,
    loadManagerStateOrEmpty,
    resetManagerStateApplyMetadata,
    saveManagerState,
} from '/app/manager/dist/index.js';

const runtimeDirectory = '/app/runtime';
const baseConfigTemplatePath = '/app/server/magic-sso.base.toml.template';
const baseConfigPath = '/app/runtime/magic-sso.base.toml';
const managerConfigTemplatePath = '/app/manager/manager.toml.template';
const managerConfigPath = '/app/runtime/manager.toml';
const managerStateTemplatePath = '/app/manager/manager-state.json.template';
const managerStatePath = '/app/runtime/manager-state.json';

function renderTemplate(templatePath, outputPath) {
    const template = readFileSync(templatePath, 'utf8');
    const rendered = template.replaceAll(/\$\{([A-Z0-9_]+)\}/g, (_match, key) => {
        const value = process.env[key];
        if (typeof value !== 'string' || value.length === 0) {
            throw new Error(`Missing required env var for managed manager bootstrap: ${key}`);
        }

        return value;
    });
    writeFileSync(outputPath, rendered, 'utf8');
    return rendered;
}

mkdirSync(runtimeDirectory, { recursive: true });

renderTemplate(baseConfigTemplatePath, baseConfigPath);
renderTemplate(managerConfigTemplatePath, managerConfigPath);

if (!existsSync(managerStatePath)) {
    renderTemplate(managerStateTemplatePath, managerStatePath);
}

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
