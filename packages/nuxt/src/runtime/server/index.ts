// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Wojciech Polak

export type { AuthPayload, MagicSsoResolvedConfig } from '../../types';
export type { VerifyAuthTokenOptions } from './utils/auth';
export {
    DEFAULT_EXCLUDED_PATHS,
    buildLoginUrl,
    getCookieName,
    getExcludedPaths,
    getJwtSecret,
    getMagicSsoConfig,
    isPublicPath,
    normaliseReturnUrl,
    resolveMagicSsoConfig,
    verifyAuthToken,
    verifyRequestAuth,
} from './utils/auth';
