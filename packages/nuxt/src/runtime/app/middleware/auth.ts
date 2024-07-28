// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Wojciech Polak

import { defineNuxtRouteMiddleware, navigateTo, useRequestEvent } from 'nuxt/app';
import { useMagicSsoConfig } from '../composables/useMagicSso';
import { buildLoginUrl, isPublicPath, verifyRequestAuth } from '../../server/utils/auth';

export default defineNuxtRouteMiddleware(async (to) => {
    const config = useMagicSsoConfig();
    if (isPublicPath(to.path, config)) {
        return;
    }

    if (import.meta.client) {
        // Auth uses an httpOnly cookie, so client-side middleware cannot make a
        // reliable auth decision. Example protected-route links use full
        // document navigation and let the server decide.
        return;
    }

    const event = useRequestEvent();
    if (!event) {
        return;
    }

    const payload = await verifyRequestAuth(event);
    if (payload !== null) {
        return;
    }

    return navigateTo(buildLoginUrl(event, to.fullPath), {
        external: config.directUse,
        redirectCode: 307,
    });
});
