// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 Wojciech Polak
import type { AppConfig, SiteConfig } from './config.js';

export const launcherPath = '/sso/apps';

export function launcherEnabled(config: AppConfig): boolean {
    return config.browserSso?.enabled === true && config.sites.some((site) => site.launcher);
}

export interface LauncherApplication {
    name: string;
    href: string;
}

export function launcherApplications(
    config: AppConfig,
    email: string,
    siteAllows: (site: SiteConfig, email: string, scope: string) => boolean,
): LauncherApplication[] {
    return config.sites.flatMap((site): LauncherApplication[] => {
        const entry = site.launcher;
        if (!entry || !siteAllows(site, email, entry.scope)) {
            return [];
        }
        const origin = new URL(entry.launchUrl).origin;
        const registration = site.sso?.find((item) => new URL(item.startUri).origin === origin);
        if (!registration) {
            return [];
        }
        const start = new URL(registration.startUri);
        start.searchParams.set('returnUrl', entry.launchUrl);
        start.searchParams.set('scope', entry.scope);
        return [{ name: entry.name, href: start.href }];
    });
}
