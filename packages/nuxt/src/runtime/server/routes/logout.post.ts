// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Wojciech Polak

import { defineEventHandler, deleteCookie, sendRedirect } from 'h3';
import type { H3Event } from 'h3';
import {
    getCookieName,
    getMagicSsoConfig,
    getRequestOrigin,
    readFirstHeaderValue,
} from '../utils/auth';

function hasSameOriginMutationSource(event: H3Event): boolean {
    const expectedOrigin = getRequestOrigin(event, {
        allowRequestUrlFallback: true,
    });
    if (expectedOrigin === null) {
        return false;
    }

    const originHeader = readFirstHeaderValue(event.node.req.headers.origin);
    if (originHeader !== null) {
        return originHeader === expectedOrigin;
    }

    const refererHeader = readFirstHeaderValue(event.node.req.headers.referer);
    if (refererHeader === null) {
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
