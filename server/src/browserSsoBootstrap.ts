// SPDX-License-Identifier: GPL-3.0-or-later
import { hashBrowserSsoToken } from '@magic-link-sso/config-core/runtime';
import { z } from 'zod';
import type { AppConfig } from './config.js';
import type { BrowserSsoStore } from './browserSsoStore.js';
export const bootstrapContextSchema = z
    .object({
        requestId: z.string().regex(/^[A-Za-z0-9_-]{43}$/),
        codeVerifier: z.string().regex(/^[A-Za-z0-9._~-]{43,128}$/),
        redirectUri: z.string().url().max(2048),
    })
    .strict();
export type BrowserSsoBootstrapError =
    | 'invalid_request'
    | 'request_expired'
    | 'access_denied'
    | 'temporarily_unavailable';
export interface BrowserSsoBootstrapResponse {
    browserSso?: { bootstrapTicket: string } | { error: BrowserSsoBootstrapError };
}
export function browserSsoBootstrapEnabled(config: AppConfig): boolean {
    return config.browserSso?.enabled === true && config.browserSso.bootstrapEnabled === true;
}
export function bootstrapJwtLifetime(config: AppConfig, context: unknown): number {
    return context !== undefined && browserSsoBootstrapEnabled(config)
        ? Math.min(config.jwtExpirationSeconds, config.browserSso?.sessionLifetimeSeconds ?? 28_800)
        : config.jwtExpirationSeconds;
}
export async function bindBrowserSsoBootstrapGrant(
    config: AppConfig,
    store: BrowserSsoStore,
    context: unknown,
    input: { siteId: string; scope: string; grantId: string },
): Promise<BrowserSsoBootstrapError | null> {
    if (context === undefined || !browserSsoBootstrapEnabled(config)) {
        return null;
    }
    const parsed = bootstrapContextSchema.safeParse(context);
    if (!parsed.success) {
        return 'invalid_request';
    }
    try {
        const pending = await store.inspectBootstrapRequest({
            ...parsed.data,
            siteId: input.siteId,
            now: Date.now(),
        });
        if (!pending || pending.scope !== input.scope) {
            return 'request_expired';
        }
        return (await store.bindBootstrapGrant({
            ...parsed.data,
            siteId: input.siteId,
            scope: input.scope,
            grantId: input.grantId,
            now: Date.now(),
        }))
            ? null
            : 'request_expired';
    } catch {
        return 'temporarily_unavailable';
    }
}
export async function completeBrowserSsoBootstrap(
    config: AppConfig,
    store: BrowserSsoStore,
    context: unknown,
    input: {
        siteId: string;
        scope: string;
        grantId: string;
        email: string;
        accessToken: string;
        siteAllows(siteId: string, email: string, scope: string): boolean;
    },
): Promise<BrowserSsoBootstrapResponse> {
    if (context === undefined || !browserSsoBootstrapEnabled(config)) {
        return {};
    }
    const parsed = bootstrapContextSchema.safeParse(context);
    if (!parsed.success) {
        return { browserSso: { error: 'invalid_request' } };
    }
    try {
        const target = config.sites.find((site) => site.id === input.siteId);
        if (!target?.sso?.some((entry) => entry.redirectUri === parsed.data.redirectUri)) {
            return { browserSso: { error: 'invalid_request' } };
        }
        if (!input.siteAllows(input.siteId, input.email, input.scope)) {
            return { browserSso: { error: 'access_denied' } };
        }
        const result = await store.issueBootstrapTicket({
            ...parsed.data,
            siteId: input.siteId,
            scope: input.scope,
            grantId: input.grantId,
            email: input.email.toLowerCase(),
            accessTokenHash: await hashBrowserSsoToken(input.accessToken),
            now: Date.now(),
            lifetimeSeconds: config.browserSso?.codeLifetimeSeconds ?? 60,
        });
        if (!input.siteAllows(input.siteId, input.email, input.scope)) {
            return { browserSso: { error: 'access_denied' } };
        }
        return result.kind === 'issued'
            ? { browserSso: { bootstrapTicket: result.ticket } }
            : { browserSso: { error: 'request_expired' } };
    } catch {
        return { browserSso: { error: 'temporarily_unavailable' } };
    }
}
