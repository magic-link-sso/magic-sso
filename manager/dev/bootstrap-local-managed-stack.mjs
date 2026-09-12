// SPDX-License-Identifier: GPL-3.0-or-later

import { dirname, join } from 'node:path';
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { applyBootstrappedManagerState, renderEnvTemplate } from './managed-stack.mjs';

const scriptDirectory = dirname(fileURLToPath(import.meta.url));
const managerDirectory = dirname(scriptDirectory);
const runtimeDirectory = join(managerDirectory, 'runtime');
const managerConfigPath =
    process.env.MAGICSSO_MANAGER_CONFIG_FILE ?? join(runtimeDirectory, 'manager.toml');
const managerStatePath = join(runtimeDirectory, 'manager-state.json');

if (!existsSync(managerStatePath)) {
    renderEnvTemplate(
        join(scriptDirectory, 'manager-state.json.template'),
        managerStatePath,
        'local manager bootstrap',
    );
}

await applyBootstrappedManagerState(managerConfigPath);
