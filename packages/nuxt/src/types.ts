// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Wojciech Polak

import type { BrowserSsoMode, AuthPayload as CoreAuthPayload } from '@magic-link-sso/core';

export type AuthPayload = CoreAuthPayload;

export interface MagicSsoModuleOptions {
    browserSsoLoginUi?: 'hosted' | 'app-owned';
    browserSsoMode?: BrowserSsoMode;
    browserSsoAllowInsecureLocalhost?: boolean;
    browserSsoTimeoutMs?: number;
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
    browserSsoLoginUi: 'hosted' | 'app-owned';
    browserSsoMode: BrowserSsoMode;
    browserSsoAllowInsecureLocalhost: boolean;
    browserSsoTimeoutMs: number;
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
