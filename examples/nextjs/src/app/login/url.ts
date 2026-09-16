// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Wojciech Polak

import { buildLoginTarget as buildCoreLoginTarget, parseBooleanFlag } from '@magic-link-sso/core';

interface HeaderReader {
    get(name: string): string | null;
}

/** Resolve this app's public origin from the (possibly proxied) request headers. */
export function getAppOrigin(headerStore: HeaderReader): string {
    const host = headerStore.get('x-forwarded-host') ?? headerStore.get('host') ?? 'localhost:3001';
    return `${readProtocol(headerStore, host)}://${host}`;
}

function readProtocol(headerStore: HeaderReader, host: string): string {
    return (
        headerStore.get('x-forwarded-proto') ?? (host.startsWith('localhost') ? 'http' : 'https')
    );
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
