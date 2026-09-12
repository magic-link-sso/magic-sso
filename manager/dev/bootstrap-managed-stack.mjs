// SPDX-License-Identifier: GPL-3.0-or-later

import { existsSync, mkdirSync } from 'node:fs';
import { applyBootstrappedManagerState, renderEnvTemplate } from './managed-stack.mjs';

const context = 'managed manager bootstrap';
const runtimeDirectory = '/app/runtime';
const managerConfigPath = '/app/runtime/manager.toml';
const managerStatePath = '/app/runtime/manager-state.json';

mkdirSync(runtimeDirectory, { recursive: true });

renderEnvTemplate(
    '/app/server/magic-sso.base.toml.template',
    '/app/runtime/magic-sso.base.toml',
    context,
);
renderEnvTemplate('/app/manager/manager.toml.template', managerConfigPath, context);

if (!existsSync(managerStatePath)) {
    renderEnvTemplate('/app/manager/manager-state.json.template', managerStatePath, context);
}

await applyBootstrappedManagerState(managerConfigPath);
