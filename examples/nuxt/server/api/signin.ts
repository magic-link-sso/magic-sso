// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Wojciech Polak

import { readServerUrlConfigError as readSharedServerUrlConfigError } from 'magic-sso-example-ui/signin';

export function readServerUrlConfigError(serverUrl: string, requestOrigin: string): string | null {
    return readSharedServerUrlConfigError(serverUrl, requestOrigin, 'Nuxt');
}
