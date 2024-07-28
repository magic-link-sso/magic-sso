// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Wojciech Polak

import type { JWTPayload } from 'jose';

export interface AuthPayload extends JWTPayload {
    email: string;
    scope: string;
    siteId: string;
}

export interface MagicSsoModuleOptions {
    previewSecret?: string;
    serverUrl?: string;
    jwtSecret?: string;
    cookieName?: string;
    cookiePath?: string;
    cookieMaxAge?: number;
    directUse?: boolean;
    publicOrigin?: string;
    trustProxy?: boolean;
    excludedPaths?: readonly string[];
    authEverywhere?: boolean;
}

export interface MagicSsoResolvedConfig {
    previewSecret: string;
    serverUrl: string;
    jwtSecret: string;
    cookieName: string;
    cookiePath: string;
    cookieMaxAge?: number;
    directUse: boolean;
    publicOrigin: string;
    trustProxy: boolean;
    excludedPaths: readonly string[];
    authEverywhere: boolean;
}
