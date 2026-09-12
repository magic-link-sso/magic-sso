// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Wojciech Polak

import { buildLoginTarget as buildCoreLoginTarget, parseBooleanFlag } from '@magic-link-sso/core';

export function getAppOrigin(host: string, forwardedProtocol?: string | null): string {
    const protocol = forwardedProtocol ?? (host.startsWith('localhost') ? 'http' : 'https');
    return `${protocol}://${host}`;
}

export function buildLoginTarget(appOrigin: string, scope?: string): string {
    return buildCoreLoginTarget({
        appOrigin,
        directUse: parseBooleanFlag(process.env.MAGICSSO_DIRECT_USE),
        returnUrl: '/',
        ...(typeof scope === 'string' ? { scope } : {}),
        serverUrl: process.env.MAGICSSO_SERVER_URL ?? '',
    });
}
