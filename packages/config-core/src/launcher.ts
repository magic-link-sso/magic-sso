// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 Wojciech Polak
import { z } from 'zod';
import type { SiteConfig } from './index.js';

export const launcherConfigSchema = z
    .object({
        name: z.string().trim().min(1).max(100),
        launchUrl: z.string().url().max(2048),
        scope: z
            .string()
            .trim()
            .min(1)
            .refine(
                (value) => new TextEncoder().encode(value).length <= 256,
                'scope must fit within 256 UTF-8 bytes',
            )
            .default('*'),
    })
    .strict();

export type LauncherConfig = z.infer<typeof launcherConfigSchema>;

/** A launcher destination belongs to an explicit SSO registration and redirect policy. */
export function validateLauncherConfiguration(sites: readonly SiteConfig[]): void {
    for (const site of sites) {
        const launcher = site.launcher;
        if (!launcher) {
            continue;
        }
        const url = new URL(launcher.launchUrl);
        const registration = site.sso?.find(
            (entry) => new URL(entry.startUri).origin === url.origin,
        );
        const allowedPath = site.allowedRedirectUris.some(
            (rule) =>
                rule.origin === url.origin &&
                (rule.pathname === url.pathname ||
                    (rule.match === 'subpath' &&
                        url.pathname.startsWith(rule.pathname) &&
                        (rule.pathname.endsWith('/') ||
                            url.pathname[rule.pathname.length] === '/'))),
        );
        if (
            !registration ||
            !allowedPath ||
            url.username ||
            url.password ||
            url.hash ||
            launcher.launchUrl.includes('#') ||
            url.pathname.includes('*') ||
            url.href !== launcher.launchUrl ||
            // eslint-disable-next-line no-control-regex -- Reject URL whitespace and control characters before navigation.
            /[\\\u0000-\u0020\u007f]/u.test(launcher.launchUrl) ||
            /%(?:0[0-9a-f]|1[0-9a-f]|25|2f|5c|2e|7f)/iu.test(url.pathname) ||
            [registration.startUri, registration.redirectUri, registration.signedOutUri].some(
                (endpoint) => new URL(endpoint).pathname === url.pathname,
            )
        ) {
            throw new Error(
                `sites[${site.id}].launcher.launchUrl must be a canonical application URL under its registered SSO origin and allowedRedirectUris, outside its SSO endpoints.`,
            );
        }
    }
}
