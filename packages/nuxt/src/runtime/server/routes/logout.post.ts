// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Wojciech Polak

import { defineEventHandler, deleteCookie, getRequestURL, sendRedirect } from 'h3';
import type { H3Event } from 'h3';
import { getCookieName, getMagicSsoConfig } from '../utils/auth';

function readHeaderValue(value: string | string[] | undefined): string | undefined {
    if (Array.isArray(value)) {
        return typeof value[0] === 'string' ? value[0] : undefined;
    }

    return typeof value === 'string' && value.length > 0 ? value : undefined;
}

function hasSameOriginMutationSource(event: H3Event): boolean {
    const expectedOrigin = getRequestURL(event).origin;
    const originHeader = readHeaderValue(event.node.req.headers.origin);
    if (typeof originHeader === 'string') {
        return originHeader === expectedOrigin;
    }

    const refererHeader = readHeaderValue(event.node.req.headers.referer);
    if (typeof refererHeader !== 'string') {
        return false;
    }

    try {
        return new URL(refererHeader).origin === expectedOrigin;
    } catch {
        return false;
    }
}

export default defineEventHandler(async (event): Promise<Response | void> => {
    if (event.node.req.method !== 'POST') {
        return new Response('Method Not Allowed', {
            status: 405,
            headers: {
                Allow: 'POST',
            },
        });
    }

    if (!hasSameOriginMutationSource(event)) {
        return new Response('Forbidden', {
            status: 403,
        });
    }

    const config = getMagicSsoConfig(event);
    deleteCookie(event, getCookieName(event), {
        path: config.cookiePath,
        httpOnly: true,
        secure: process.env.NODE_ENV === 'production',
        sameSite: 'lax',
    });

    await sendRedirect(event, '/', 303);
});
