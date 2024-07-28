// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Wojciech Polak

export type {
    AuthCookieOptions,
    AuthPayload,
    MagicSsoConfig,
    MagicSsoResolvedConfig,
    VerifyAuthTokenOptions,
} from './lib/core';
export {
    buildAuthCookieOptions,
    buildLoginPath,
    buildLoginTarget,
    buildVerifyUrl,
    getCookieMaxAge,
    getCookieName,
    getCookiePath,
    getJwtSecret,
    getMagicSsoConfig,
    normaliseReturnUrl,
    readCookieValue,
    resolveMagicSsoConfig,
    verifyAuthToken,
    verifyRequestAuth,
} from './lib/core';
