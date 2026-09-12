// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Wojciech Polak

import { bootstrapExampleEnvFile } from 'magic-sso-example-ui/env-file';

export const ensureEnvFile = await bootstrapExampleEnvFile({
    envPath: '../.env',
    examplePath: '../.env.example',
    generatedPlaceholderValues: new Map([
        [
            'MAGICSSO_JWT_SECRET',
            new Set([
                'replace-me-with-a-long-random-jwt-secret',
                'VERY-VERY-LONG-RANDOM-JWT-SECRET',
            ]),
        ],
        ['MAGICSSO_PREVIEW_SECRET', new Set(['replace-me-with-a-long-random-preview-secret'])],
    ]),
    moduleUrl: import.meta.url,
});
