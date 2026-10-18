// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 Wojciech Polak

import {
    BROWSER_SSO_DEFAULTS,
    BROWSER_SSO_LIMITS,
    type BrowserSsoLifetimes,
} from '@magic-link-sso/core';
import { z } from 'zod';

export interface BrowserSsoConfig extends BrowserSsoLifetimes {
    enabled: boolean;
    bootstrapEnabled?: boolean;
    allowInsecureLocalhost: boolean;
}

export interface BrowserSsoRegistration {
    redirectUri: string;
    startUri: string;
    signedOutUri: string;
}

export const browserSsoConfigSchema = z
    .object({
        enabled: z.boolean().default(false),
        bootstrapEnabled: z.boolean().optional(),
        allowInsecureLocalhost: z.boolean().default(false),
        sessionLifetimeSeconds: z
            .number()
            .int()
            .min(BROWSER_SSO_LIMITS.minSessionSeconds)
            .max(BROWSER_SSO_LIMITS.maxSessionSeconds)
            .default(BROWSER_SSO_DEFAULTS.sessionLifetimeSeconds),
        requestLifetimeSeconds: z
            .number()
            .int()
            .min(BROWSER_SSO_LIMITS.minRequestSeconds)
            .max(BROWSER_SSO_LIMITS.maxRequestSeconds)
            .default(BROWSER_SSO_DEFAULTS.requestLifetimeSeconds),
        codeLifetimeSeconds: z
            .number()
            .int()
            .min(BROWSER_SSO_LIMITS.minCodeSeconds)
            .max(BROWSER_SSO_LIMITS.maxCodeSeconds)
            .default(BROWSER_SSO_DEFAULTS.codeLifetimeSeconds),
    })
    .strict();

export const browserSsoRegistrationSchema = z
    .object({
        redirectUri: z.string().min(1),
        startUri: z.string().min(1),
        signedOutUri: z.string().min(1),
    })
    .strict();

interface RegistrationSite {
    id: string;
    origins: Set<string>;
    sso?: BrowserSsoRegistration[] | undefined;
}

function isLocalHostname(hostname: string): boolean {
    return (
        hostname === 'localhost' ||
        hostname.endsWith('.localhost') ||
        hostname === '127.0.0.1' ||
        hostname === '[::1]'
    );
}

function parseEndpoint(value: string, setting: string, allowInsecureLocalhost: boolean): URL {
    let url: URL;
    try {
        url = new URL(value);
    } catch {
        throw new Error(`${setting} must be an absolute URL.`);
    }
    if (
        url.username ||
        url.password ||
        url.search ||
        url.hash ||
        value.includes('*') ||
        value.includes('\\') ||
        value.includes('?') ||
        value.includes('#') ||
        url.hostname.endsWith('.') ||
        /%(?:0[0-9a-f]|1[0-9a-f]|25|2f|5c|2e|7f)/iu.test(value) ||
        url.href !== value
    ) {
        throw new Error(
            `${setting} must be an exact canonical URL without credentials, wildcards, queries, fragments, or ambiguous paths.`,
        );
    }
    if (
        url.protocol !== 'https:' &&
        !(allowInsecureLocalhost && url.protocol === 'http:' && isLocalHostname(url.hostname))
    ) {
        throw new Error(
            `${setting} requires HTTPS; local HTTP requires auth.sso.allowInsecureLocalhost=true and a localhost or loopback hostname.`,
        );
    }
    return url;
}

function validateIssuerConfiguration(
    policy: BrowserSsoConfig,
    issuerUrl: string,
    sites: readonly RegistrationSite[],
    appCookieName: string,
): void {
    const issuer = new URL(issuerUrl);
    if (
        issuer.pathname !== '/' ||
        issuer.search ||
        issuer.hash ||
        issuer.username ||
        issuer.password
    ) {
        throw new Error('server.appUrl must be an issuer origin when auth.sso is configured.');
    }
    parseEndpoint(`${issuer.origin}/`, 'server.appUrl', policy.allowInsecureLocalhost);
    const reservedCookies = [
        '__Host-magic-sso-browser',
        'magic-sso-browser',
        '__Host-magic-sso-browser-binding',
        'magic-sso-browser-binding',
    ];
    if (reservedCookies.includes(appCookieName)) {
        throw new Error('cookie.name conflicts with a reserved browser SSO cookie name.');
    }
    for (const site of sites) {
        for (const origin of site.origins) {
            if (
                new URL(origin).hostname.replace(/\.+$/u, '') ===
                issuer.hostname.replace(/\.+$/u, '')
            ) {
                throw new Error(
                    `Browser SSO needs a dedicated issuer hostname; sites[${site.id}].origins shares the issuer hostname.`,
                );
            }
        }
    }
}

function validateRegistration(
    site: RegistrationSite,
    registration: BrowserSsoRegistration,
    policy: BrowserSsoConfig,
): string {
    const callbacks = Object.entries(registration).map(([field, value]) =>
        parseEndpoint(value, `sites[${site.id}].sso.${field}`, policy.allowInsecureLocalhost),
    );
    const callback = callbacks[0];
    if (!callback) {
        throw new Error(`sites[${site.id}].sso needs a callback registration.`);
    }
    if (callbacks.some((url) => url.origin !== callback.origin || !site.origins.has(url.origin))) {
        throw new Error(`sites[${site.id}].sso endpoints must share one configured site origin.`);
    }
    if (new Set(callbacks.map((url) => url.href)).size !== 3) {
        throw new Error(
            `sites[${site.id}].sso callback, start, and signed-out endpoints must be distinct.`,
        );
    }
    return callback.origin;
}

/** Registrations are operator-owned even while SSO is disabled during rollout. */
export function validateBrowserSsoConfiguration(
    policy: BrowserSsoConfig | undefined,
    issuerUrl: string,
    sites: readonly RegistrationSite[],
    appCookieName: string,
): void {
    const registrations = sites.flatMap((site) =>
        (site.sso ?? []).map((registration) => ({ site, registration })),
    );
    if (!policy && registrations.length === 0) {
        return;
    }
    if (!policy) {
        throw new Error('Configure [auth.sso] before registering sites.sso callbacks.');
    }
    if (policy.bootstrapEnabled && !policy.enabled) {
        throw new Error('auth.sso.bootstrapEnabled requires auth.sso.enabled.');
    }
    if (policy.enabled && registrations.length === 0) {
        throw new Error('auth.sso.enabled requires at least one [[sites.sso]] registration.');
    }
    if (registrations.length === 0) {
        return;
    }
    validateIssuerConfiguration(policy, issuerUrl, sites, appCookieName);
    const origins = new Set<string>();
    for (const { site, registration } of registrations) {
        const origin = validateRegistration(site, registration, policy);
        if (origins.has(origin)) {
            throw new Error(`sites.sso permits only one registration per public origin: ${origin}`);
        }
        origins.add(origin);
    }
}
