// SPDX-License-Identifier: GPL-3.0-or-later
import { parseBrowserSsoCapabilities } from '@magic-link-sso/config-core/runtime';
import { addDiagnostic, type DiagnosticReport } from '@magic-link-sso/config-core/diagnostics';
import type { AppConfig } from './config.js';
export async function checkDoctorBrowserSso(
    report: DiagnosticReport,
    config: AppConfig,
    online: boolean,
    timeoutMs: number,
    fetcher: typeof fetch = fetch,
): Promise<void> {
    const policy = config.browserSso;
    if (!policy?.enabled) {
        addDiagnostic(report, {
            id: 'browser-sso',
            setting: 'auth.sso.enabled',
            correction: 'No changes required unless opting in browser SSO.',
            status: 'pass',
            message:
                'Browser SSO is explicitly disabled; legacy application sign-in remains available.',
        });
        return;
    }
    const count = config.sites.reduce((total, site) => total + (site.sso?.length ?? 0), 0);
    addDiagnostic(report, {
        id: 'browser-sso',
        setting: 'sites.sso',
        status: count ? 'pass' : 'warn',
        message: `${count} exact callback registrations; central cookies are host-only. App JWTs keep independent expiry and logout.`,
        ...(count
            ? {
                  correction:
                      'Keep callback URLs exact and restart the issuer after policy or registration changes.',
              }
            : {
                  correction:
                      'Register each app start, callback and signed-out URL before opting in its adapter.',
              }),
    });
    if (!online) {
        addDiagnostic(report, {
            id: 'browser-sso.capabilities',
            setting: 'server.appUrl',
            status: 'skip',
            message: 'Offline mode; deployed browser SSO capabilities were not contacted.',
            correction: 'Run doctor --online to compare deployed protocol support.',
        });
        return;
    }
    try {
        const response = await fetcher(new URL('/sso/capabilities', config.appUrl), {
            redirect: 'error',
            cache: 'no-store',
            headers: { accept: 'application/json' },
            signal: AbortSignal.timeout(timeoutMs),
        });
        const body = response.ok ? await response.text() : '';
        const document: unknown = body.length <= 16_384 && body ? JSON.parse(body) : null;
        const result = parseBrowserSsoCapabilities(document);
        if (
            !response.ok ||
            response.redirected ||
            result.kind !== 'supported' ||
            (config.browserSso?.bootstrapEnabled === true &&
                result.capabilities.appOwnedBootstrapVersion !== 1)
        ) {
            throw new Error('Unsupported deployed protocol');
        }
        addDiagnostic(report, {
            id: 'browser-sso.capabilities',
            setting: 'server.appUrl',
            status: 'pass',
            message: config.browserSso?.bootstrapEnabled
                ? 'Deployed issuer supports browser SSO v1, hosted login, S256 and app-owned bootstrap v1.'
                : 'Deployed issuer supports browser SSO v1, hosted login and S256.',
            correction: 'No changes required.',
        });
    } catch {
        addDiagnostic(report, {
            id: 'browser-sso.capabilities',
            setting: 'server.appUrl',
            status: 'fail',
            message: 'Deployed browser SSO capabilities could not be verified.',
            correction:
                'Check issuer URL, HTTPS trust, proxy routing and deployed version. Auto fallback is allowed only for 404 or explicit disabled/unsupported support; never retry an exchanged code.',
        });
    }
}
