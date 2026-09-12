// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Wojciech Polak

import { getCookie, getRequestURL, type H3Event } from 'h3';
import {
    parseBooleanFlag,
    buildLoginTarget as buildCoreLoginTarget,
    normaliseReturnUrl as normaliseCoreReturnUrl,
    verifyAuthTokenWithOptionalIssuer as verifyCoreAuthTokenWithOptionalIssuer,
} from '@magic-link-sso/core';
import { DEFAULT_EXCLUDED_PATHS } from '../../../constants';
import type { AuthPayload, MagicSsoModuleOptions, MagicSsoResolvedConfig } from '../../../types';

export { DEFAULT_EXCLUDED_PATHS } from '../../../constants';
export type { AuthPayload, MagicSsoModuleOptions, MagicSsoResolvedConfig } from '../../../types';

export interface VerifyAuthTokenOptions {
    expectedAudience: string;
    expectedIssuer?: string;
}

function asRecord(value: unknown): Record<string, unknown> | null {
    if (typeof value !== 'object' || value === null) {
        return null;
    }

    // Safe after checking for a non-null object.
    return value as Record<string, unknown>;
}

function readString(value: unknown, fallback: string): string {
    return typeof value === 'string' ? value : fallback;
}

function readAbsoluteOrigin(value: unknown, fallback: string): string {
    if (typeof value !== 'string' || value.trim().length === 0) {
        return fallback;
    }

    try {
        return new URL(value).origin;
    } catch {
        return fallback;
    }
}

function readBoolean(value: unknown, fallback: boolean): boolean {
    return parseBooleanFlag(value, fallback);
}

function readPositiveInteger(value: unknown): number | undefined {
    if (typeof value === 'number' && Number.isInteger(value) && value > 0) {
        return value;
    }
    if (typeof value === 'string') {
        const trimmed = value.trim();
        if (trimmed.length === 0) {
            return undefined;
        }

        const parsed = Number.parseInt(trimmed, 10);
        if (Number.isInteger(parsed) && parsed > 0) {
            return parsed;
        }
    }

    return undefined;
}

function readCookiePath(value: unknown): string {
    if (typeof value !== 'string' || value.trim().length === 0) {
        return '/';
    }

    const normalisedValue = value.trim();
    if (!normalisedValue.startsWith('/')) {
        throw new Error('MAGICSSO_COOKIE_PATH must start with "/".');
    }

    return normalisedValue;
}

function readStringArray(value: unknown, fallback: readonly string[]): readonly string[] {
    if (!Array.isArray(value)) {
        return fallback;
    }

    const items: string[] = [];
    for (const entry of value) {
        if (typeof entry === 'string' && entry.length > 0) {
            items.push(entry);
        }
    }

    return items.length > 0 ? items : fallback;
}

function isH3Event(value: unknown): value is H3Event {
    const record = asRecord(value);
    return record !== null && 'context' in record;
}

function readJwtIssuer(serverUrl: string): string | null {
    if (serverUrl.length === 0) {
        return null;
    }

    try {
        return new URL(serverUrl).origin;
    } catch {
        return null;
    }
}

function getEnvMagicSsoConfigValue(): MagicSsoModuleOptions {
    return {
        previewSecret: process.env.MAGICSSO_PREVIEW_SECRET ?? '',
        serverUrl: process.env.MAGICSSO_SERVER_URL ?? process.env.APP_URL ?? '',
        jwtSecret: process.env.MAGICSSO_JWT_SECRET ?? process.env.JWT_SECRET ?? '',
        cookieName: process.env.MAGICSSO_COOKIE_NAME ?? process.env.COOKIE_NAME ?? 'token',
        cookiePath: process.env.MAGICSSO_COOKIE_PATH,
        cookieMaxAge: readPositiveInteger(process.env.MAGICSSO_COOKIE_MAX_AGE),
        directUse: readBoolean(process.env.MAGICSSO_DIRECT_USE, false),
        publicOrigin: process.env.MAGICSSO_PUBLIC_ORIGIN ?? '',
        trustProxy: readBoolean(process.env.MAGICSSO_TRUST_PROXY, false),
    };
}

function getMagicSsoConfigValue(event: H3Event): unknown {
    const context = asRecord(event.context);
    const nitro = asRecord(context?.nitro);
    const runtimeConfig = asRecord(nitro?.runtimeConfig);

    return runtimeConfig?.magicSso ?? getEnvMagicSsoConfigValue();
}

export function resolveMagicSsoConfig(configValue?: unknown): MagicSsoResolvedConfig {
    const config = asRecord(configValue);

    return {
        previewSecret: readString(config?.previewSecret, ''),
        serverUrl: readString(config?.serverUrl, ''),
        jwtSecret: readString(config?.jwtSecret, ''),
        cookieName: readString(config?.cookieName, 'token'),
        cookiePath: readCookiePath(config?.cookiePath),
        cookieMaxAge: readPositiveInteger(config?.cookieMaxAge),
        directUse: readBoolean(config?.directUse, false),
        publicOrigin: readAbsoluteOrigin(config?.publicOrigin, ''),
        trustProxy: readBoolean(config?.trustProxy, false),
        excludedPaths: readStringArray(config?.excludedPaths, [...DEFAULT_EXCLUDED_PATHS]),
        authEverywhere: readBoolean(config?.authEverywhere, false),
    };
}

export function getMagicSsoConfig(source?: unknown): MagicSsoResolvedConfig {
    if (typeof source === 'undefined') {
        return resolveMagicSsoConfig(getEnvMagicSsoConfigValue());
    }

    return isH3Event(source)
        ? resolveMagicSsoConfig(getMagicSsoConfigValue(source))
        : resolveMagicSsoConfig(source);
}

export function getCookieName(source?: unknown): string {
    return getMagicSsoConfig(source).cookieName;
}

export function getJwtSecret(source?: unknown): Uint8Array | null {
    const jwtSecret = getMagicSsoConfig(source).jwtSecret;
    if (jwtSecret.length === 0) {
        return null;
    }

    return new TextEncoder().encode(jwtSecret);
}

export function getExcludedPaths(
    options?: Pick<MagicSsoResolvedConfig, 'excludedPaths'>,
): readonly string[] {
    const configuredPaths = options?.excludedPaths;
    if (typeof configuredPaths === 'undefined') {
        return DEFAULT_EXCLUDED_PATHS;
    }

    return configuredPaths;
}

export function isPublicPath(
    pathname: string,
    options?: Pick<MagicSsoResolvedConfig, 'excludedPaths'>,
): boolean {
    return getExcludedPaths(options).some(
        (path) => pathname === path || pathname.startsWith(`${path}/`),
    );
}

export function buildLoginUrl(event: H3Event, pathname: string, scope?: string): string {
    const requestUrl = getRequestURL(event);
    const config = getMagicSsoConfig(event);
    return buildCoreLoginTarget({
        appOrigin: requestUrl.origin,
        directUse: config.directUse,
        returnUrl: pathname,
        ...(typeof scope === 'string' ? { scope } : {}),
        serverUrl: config.serverUrl,
    });
}

export function normaliseReturnUrl(returnUrl: string | undefined, origin: string): string {
    const normalised = normaliseCoreReturnUrl({ appOrigin: origin, fallback: '/', returnUrl });
    if (typeof returnUrl === 'string' && returnUrl.startsWith('/') && !returnUrl.startsWith('//')) {
        const url = new URL(normalised);
        return `${url.pathname}${url.search}${url.hash}`;
    }
    return normalised === new URL('/', origin).toString() ? '/' : normalised;
}

export function readFirstHeaderValue(value: string | string[] | undefined): string | null {
    if (Array.isArray(value)) {
        return typeof value[0] === 'string' ? value[0] : null;
    }

    return typeof value === 'string' && value.length > 0 ? value : null;
}

function inferOriginProtocol(host: string): string {
    return host.startsWith('localhost') || host.startsWith('127.0.0.1') ? 'http' : 'https';
}

export function getRequestOrigin(
    event: H3Event,
    options?: { allowRequestUrlFallback?: boolean },
): string | null {
    const config = getMagicSsoConfig(event);
    if (config.publicOrigin.length > 0) {
        return config.publicOrigin;
    }

    if (config.trustProxy) {
        const host =
            readFirstHeaderValue(event.node.req.headers['x-forwarded-host']) ??
            readFirstHeaderValue(event.node.req.headers.host);
        if (host !== null) {
            const forwardedProtocol = readFirstHeaderValue(
                event.node.req.headers['x-forwarded-proto'],
            );
            const protocol = forwardedProtocol ?? inferOriginProtocol(host);
            return `${protocol}://${host}`;
        }
    }

    return options?.allowRequestUrlFallback === true ? getRequestURL(event).origin : null;
}

export function hasSameOriginMutationSource(event: H3Event): boolean {
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

function getExpectedAudience(event: H3Event): string | null {
    return getRequestOrigin(event);
}

export async function verifyAuthToken(
    token: string,
    secret: Uint8Array,
    options: VerifyAuthTokenOptions,
): Promise<AuthPayload | null> {
    return verifyCoreAuthTokenWithOptionalIssuer(token, secret, options);
}

export async function verifyRequestAuth(event: H3Event): Promise<AuthPayload | null> {
    const token = getCookie(event, getCookieName(event));
    if (typeof token !== 'string' || token.length === 0) {
        return null;
    }

    const secret = getJwtSecret(event);
    if (secret === null) {
        return null;
    }

    const issuer = readJwtIssuer(getMagicSsoConfig(event).serverUrl);
    if (issuer === null) {
        return null;
    }

    const expectedAudience = getExpectedAudience(event);
    if (expectedAudience === null) {
        return null;
    }

    return verifyAuthToken(token, secret, {
        expectedAudience,
        expectedIssuer: issuer,
    });
}
