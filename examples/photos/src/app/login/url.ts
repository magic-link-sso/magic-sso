// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Wojciech Polak

import type { NextRequest } from 'next/server';

export function getAppOrigin(host: string, forwardedProtocol?: string | null): string {
    const protocol = forwardedProtocol ?? (host.startsWith('localhost') ? 'http' : 'https');
    return `${protocol}://${host}`;
}

function normalizeForwardedHost(host: string | null | undefined): string | null {
    if (typeof host !== 'string') {
        return null;
    }

    const normalizedHost = host.split(',')[0]?.trim();
    return typeof normalizedHost === 'string' && normalizedHost.length > 0 ? normalizedHost : null;
}

export function resolveAppOrigin(options: {
    explicitPublicOrigin?: string;
    fallbackOrigin?: string;
    forwardedHost?: string | null;
    forwardedProtocol?: string | null;
    host?: string | null;
}): string {
    if (
        typeof options.explicitPublicOrigin === 'string' &&
        options.explicitPublicOrigin.length > 0
    ) {
        try {
            return new URL(options.explicitPublicOrigin).origin;
        } catch {
            return options.explicitPublicOrigin;
        }
    }

    const forwardedHost = normalizeForwardedHost(options.forwardedHost);
    if (typeof forwardedHost === 'string') {
        return getAppOrigin(forwardedHost, options.forwardedProtocol);
    }

    const host = normalizeForwardedHost(options.host);
    if (typeof host === 'string') {
        return getAppOrigin(host, options.forwardedProtocol);
    }

    if (typeof options.fallbackOrigin === 'string' && options.fallbackOrigin.length > 0) {
        try {
            return new URL(options.fallbackOrigin).origin;
        } catch {
            return options.fallbackOrigin;
        }
    }

    return 'http://localhost:5001';
}

/** Resolve the public origin this app should use when answering `request`. */
export function resolveRequestAppOrigin(request: NextRequest): string {
    return resolveAppOrigin({
        explicitPublicOrigin: process.env.MAGICSSO_PUBLIC_ORIGIN,
        fallbackOrigin: request.nextUrl.origin,
        forwardedHost: request.headers.get('x-forwarded-host'),
        forwardedProtocol: request.headers.get('x-forwarded-proto'),
        host: request.headers.get('host'),
    });
}
