// SPDX-License-Identifier: GPL-3.0-or-later

import { readFileSync, writeFileSync } from 'node:fs';
import {
    applyManagerState,
    buildRuntimePlan,
    loadManagerRuntimeSettings,
    loadManagerStateOrEmpty,
    resetManagerStateApplyMetadata,
    saveManagerState,
} from '../dist/index.js';

/**
 * Render a `${ENV_VAR}` placeholder template with values from `process.env`.
 *
 * @param {string} templatePath Template file to read.
 * @param {string} outputPath Destination file to write.
 * @param {string} context Human-readable bootstrap name used in error messages.
 * @returns {string} The rendered template contents.
 */
export function renderEnvTemplate(templatePath, outputPath, context) {
    const template = readFileSync(templatePath, 'utf8');
    const rendered = template.replaceAll(/\$\{([A-Z0-9_]+)\}/g, (_match, key) => {
        const value = process.env[key];
        if (typeof value !== 'string' || value.length === 0) {
            throw new Error(`Missing required env var for ${context}: ${key}`);
        }

        return value;
    });
    writeFileSync(outputPath, rendered, 'utf8');
    return rendered;
}

/**
 * Load manager state for `managerConfigPath` and apply it once, resetting the
 * apply metadata first when the base config template changed underneath us.
 *
 * @param {string} managerConfigPath Path to the rendered `manager.toml`.
 * @returns {Promise<void>}
 */
export async function applyBootstrappedManagerState(managerConfigPath) {
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
}
