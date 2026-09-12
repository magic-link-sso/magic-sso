// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Wojciech Polak

import { bootstrapExampleEnvFile } from 'magic-sso-example-ui/env-file';

export const ensureEnvFile = await bootstrapExampleEnvFile({
    envPath: '../.env.local',
    examplePath: '../.env.local.example',
    generatedPlaceholderValues: new Map([
        ['MAGICSSO_JWT_SECRET', new Set(['replace-me-with-a-long-random-jwt-secret'])],
        ['MAGICSSO_PREVIEW_SECRET', new Set(['replace-me-with-a-long-random-preview-secret'])],
    ]),
    moduleUrl: import.meta.url,
});
