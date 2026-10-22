// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Wojciech Polak
import { isBrowserSsoInteger } from './browser-sso-validation.js';

/** Versioned contract; issuer routes and adapter participation are implemented separately. */
export const BROWSER_SSO_VERSION = 1;

export interface BrowserSsoLifetimes {
    sessionLifetimeSeconds: number;
    requestLifetimeSeconds: number;
    codeLifetimeSeconds: number;
}

export const BROWSER_SSO_DEFAULTS: Readonly<BrowserSsoLifetimes> = Object.freeze({
    sessionLifetimeSeconds: 28_800,
    requestLifetimeSeconds: 900,
    codeLifetimeSeconds: 60,
});

export const BROWSER_SSO_LIMITS = Object.freeze({
    minSessionSeconds: 300,
    maxSessionSeconds: 86_400,
    minRequestSeconds: 60,
    maxRequestSeconds: 1_800,
    minCodeSeconds: 15,
    maxCodeSeconds: 120,
    clockAllowanceSeconds: 30,
    maxPendingAppTransactions: 3,
    maxTransactionCookieBytes: 1_536,
    maxReturnUrlBytes: 512,
    capabilityCacheSeconds: 60,
});

export type BrowserSsoMode = 'off' | 'auto' | 'required';

export function parseBrowserSsoMode(value: unknown): BrowserSsoMode {
    if (value === undefined || value === '') {
        return 'off';
    }
    if (value === 'off' || value === 'auto' || value === 'required') {
        return value;
    }
    throw new Error('Browser SSO mode must be off, auto, or required.');
}
export type BrowserSsoErrorCode =
    | 'invalid_request'
    | 'invalid_callback'
    | 'access_denied'
    | 'request_expired'
    | 'code_expired'
    | 'code_rejected'
    | 'session_expired'
    | 'sso_disabled'
    | 'temporarily_unavailable';

export interface BrowserSsoAuthorizationRequest {
    redirectUri: string;
    state: string;
    codeChallenge: string;
    codeChallengeMethod: 'S256';
    scope?: string;
    prompt?: 'login';
}

export interface BrowserSsoExchangeRequest {
    code: string;
    codeVerifier: string;
    redirectUri: string;
}

export interface BrowserSsoCapabilities {
    version: 1;
    appOwnedBootstrapVersion?: number;
    enabled: true;
    loginUi: 'hosted';
    codeChallengeMethods: readonly ['S256'];
    requestLifetimeSeconds: number;
    codeLifetimeSeconds: number;
    transactionLifetimeSeconds: number;
}

export type BrowserSsoCapabilityResult =
    | { kind: 'supported'; capabilities: BrowserSsoCapabilities }
    | { kind: 'disabled' }
    | { kind: 'unsupported'; version: number }
    | { kind: 'malformed' };

/** An invalid capability document must never silently select the legacy flow. */
export function parseBrowserSsoCapabilities(value: unknown): BrowserSsoCapabilityResult {
    if (typeof value !== 'object' || value === null) {
        return { kind: 'malformed' };
    }
    const document: unknown = Reflect.get(value, 'browserSso');
    if (typeof document !== 'object' || document === null) {
        return { kind: 'malformed' };
    }
    const version: unknown = Reflect.get(document, 'version');
    const enabled: unknown = Reflect.get(document, 'enabled');
    if (!isBrowserSsoInteger(version, 1) || typeof enabled !== 'boolean') {
        return { kind: 'malformed' };
    }
    if (version !== BROWSER_SSO_VERSION) {
        return { kind: 'unsupported', version };
    }
    if (!enabled) {
        return { kind: 'disabled' };
    }
    const bootstrapVersion: unknown = Reflect.get(document, 'appOwnedBootstrapVersion');
    if (bootstrapVersion !== undefined && !isBrowserSsoInteger(bootstrapVersion, 1)) {
        return { kind: 'malformed' };
    }
    const request: unknown = Reflect.get(document, 'requestLifetimeSeconds');
    const code: unknown = Reflect.get(document, 'codeLifetimeSeconds');
    const transaction: unknown = Reflect.get(document, 'transactionLifetimeSeconds');
    const methods: unknown = Reflect.get(document, 'codeChallengeMethods');
    if (
        Reflect.get(document, 'loginUi') !== 'hosted' ||
        !Array.isArray(methods) ||
        methods.length !== 1 ||
        methods[0] !== 'S256' ||
        !isBrowserSsoInteger(
            request,
            BROWSER_SSO_LIMITS.minRequestSeconds,
            BROWSER_SSO_LIMITS.maxRequestSeconds,
        ) ||
        !isBrowserSsoInteger(
            code,
            BROWSER_SSO_LIMITS.minCodeSeconds,
            BROWSER_SSO_LIMITS.maxCodeSeconds,
        ) ||
        transaction !== request + code + BROWSER_SSO_LIMITS.clockAllowanceSeconds
    ) {
        return { kind: 'malformed' };
    }
    return {
        kind: 'supported',
        capabilities: {
            version: 1,
            ...(typeof bootstrapVersion === 'number'
                ? { appOwnedBootstrapVersion: bootstrapVersion }
                : {}),
            enabled: true,
            loginUi: 'hosted',
            codeChallengeMethods: ['S256'],
            requestLifetimeSeconds: request,
            codeLifetimeSeconds: code,
            transactionLifetimeSeconds: transaction,
        },
    };
}

export type BrowserSsoLoginUi = 'hosted' | 'app-owned';
export function parseBrowserSsoLoginUi(value: unknown): BrowserSsoLoginUi {
    if (value === undefined || value === '') {
        return 'hosted';
    }
    if (value === 'hosted' || value === 'app-owned') {
        return value;
    }
    throw new Error('Browser SSO login UI must be hosted or app-owned.');
}
