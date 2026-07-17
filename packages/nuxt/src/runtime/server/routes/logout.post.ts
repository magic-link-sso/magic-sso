// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Wojciech Polak

import { defineEventHandler, deleteCookie, sendRedirect } from 'h3';
import { getCookieName, getMagicSsoConfig, hasSameOriginMutationSource } from '../utils/auth';

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
