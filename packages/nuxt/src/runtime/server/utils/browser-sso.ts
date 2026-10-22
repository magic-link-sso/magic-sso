// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Wojciech Polak
import { createBrowserSsoHttpHandler, browserSsoPaths } from '@magic-link-sso/core';
import type { MagicSsoResolvedConfig } from '../../../types';

/** Keep discovery scoped to the trusted runtime configuration, never request parameters. */
export function createNuxtBrowserSsoHandler(
    config: MagicSsoResolvedConfig,
): (request: Request) => Promise<Response> {
    if (!config.publicOrigin) {
        throw new Error('Browser SSO requires a configured publicOrigin.');
    }
    return createBrowserSsoHttpHandler({
        mode: config.browserSsoMode,
        loginUi: config.browserSsoLoginUi,
        previewSecret: config.previewSecret,
        issuer: new URL(config.serverUrl).origin,
        audience: config.publicOrigin,
        redirectUri: new URL(browserSsoPaths.callback, config.publicOrigin).href,
        secret: config.jwtSecret,
        cookieName: config.cookieName,
        cookiePath: config.cookiePath,
        cookieMaxAge: config.cookieMaxAge,
        allowInsecureLocalhost: config.browserSsoAllowInsecureLocalhost,
        timeoutMs: config.browserSsoTimeoutMs,
        legacyDirectUse: config.directUse,
    });
}
