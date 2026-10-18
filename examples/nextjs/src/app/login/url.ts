// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Wojciech Polak

import { buildLoginTarget as buildCoreLoginTarget, parseBooleanFlag } from '@magic-link-sso/core';
import { getBrowserSsoMode } from '@magic-link-sso/nextjs';

interface HeaderReader {
    get(name: string): string | null;
}

/** Resolve this app's public origin from the (possibly proxied) request headers. */
export function getAppOrigin(headerStore: HeaderReader): string {
    if (process.env.MAGICSSO_PUBLIC_ORIGIN?.trim()) {
        return new URL(process.env.MAGICSSO_PUBLIC_ORIGIN).origin;
    }
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
        directUse:
            getBrowserSsoMode() === 'off' && parseBooleanFlag(process.env.MAGICSSO_DIRECT_USE),
        ...(getBrowserSsoMode() === 'off' ? {} : { loginPath: '/sso/start' }),
        returnUrl: '/',
        scope,
        serverUrl: process.env.MAGICSSO_SERVER_URL ?? '',
    });
}
