// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Wojciech Polak
import { defineEventHandler, toWebRequest, sendWebResponse } from 'h3';
import { getMagicSsoConfig } from '../utils/auth';
import { createNuxtBrowserSsoHandler } from '../utils/browser-sso';

let cached: { key: string; handler: (request: Request) => Promise<Response> } | undefined;

export default defineEventHandler(async (event): Promise<void> => {
    const config = getMagicSsoConfig(event);
    const key = JSON.stringify(config);
    try {
        if (!cached || cached.key !== key) {
            cached = { key, handler: createNuxtBrowserSsoHandler(config) };
        }
        await sendWebResponse(event, await cached.handler(toWebRequest(event)));
    } catch {
        await sendWebResponse(
            event,
            new Response('Browser SSO configuration is unavailable.', {
                status: 503,
                headers: { 'cache-control': 'no-store', 'referrer-policy': 'no-referrer' },
            }),
        );
    }
});
