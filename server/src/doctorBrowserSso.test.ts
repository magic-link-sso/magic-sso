// SPDX-License-Identifier: GPL-3.0-or-later
import { readFileSync } from 'node:fs';
import { describe, expect, it, vi } from 'vitest';
import type { DiagnosticReport } from '@magic-link-sso/config-core/diagnostics';
import { parseMagicSsoConfigToml } from './config.js';
import { checkDoctorBrowserSso } from './doctorBrowserSso.js';
const source = readFileSync(
    new URL('../../packages/config-core/src/browser-sso.fixture.toml', import.meta.url),
    'utf8',
);
const fixture: { enabled: { browserSso: Record<string, unknown> } } = JSON.parse(
    readFileSync(
        new URL('../../packages/core/test/fixtures/browser-sso-v1.json', import.meta.url),
        'utf8',
    ),
);
function report(): DiagnosticReport {
    return { component: 'server', checks: [] };
}
describe('browser SSO deployment diagnostics', () => {
    it('does not contact the issuer or expose secrets during offline/disabled checks', async () => {
        const fetcher = vi.fn<typeof fetch>();
        for (const enabled of [false, true]) {
            const config = parseMagicSsoConfigToml(
                source.replace('enabled = false', `enabled = ${enabled}`),
                'fixture',
            );
            const result = report();
            await checkDoctorBrowserSso(result, config, false, 1000, fetcher);
            expect(result.checks[0]?.status).toBe('pass');
            expect(JSON.stringify(result)).not.toContain(config.jwtSecret);
        }
        expect(fetcher).not.toHaveBeenCalled();
    });
    it.each(['supported', '404', 'disabled', 'malformed', 'redirect', 'network'])(
        'reports deployed capability outcome %s without sensitive payloads',
        async (kind) => {
            const config = parseMagicSsoConfigToml(
                source.replace('enabled = false', 'enabled = true'),
                'fixture',
            );
            const fetcher = vi.fn<typeof fetch>(async () => {
                if (kind === 'network') {
                    throw new Error('sensitive-network-detail');
                }
                return kind === '404'
                    ? new Response(null, { status: 404 })
                    : kind === 'redirect'
                      ? new Response(null, { status: 302 })
                      : Response.json(
                            kind === 'supported'
                                ? fixture.enabled
                                : kind === 'disabled'
                                  ? { browserSso: { version: 1, enabled: false } }
                                  : { secret: 'sensitive-network-detail' },
                        );
            });
            const result = report();
            await checkDoctorBrowserSso(result, config, true, 1000, fetcher);
            expect(result.checks.at(-1)?.status).toBe(kind === 'supported' ? 'pass' : 'fail');
            expect(fetcher).toHaveBeenCalledWith(
                new URL('/sso/capabilities', config.appUrl),
                expect.objectContaining({ redirect: 'error', cache: 'no-store' }),
            );
            expect(JSON.stringify(result)).not.toContain('sensitive-network-detail');
        },
    );
    it('verifies bootstrap support when the issuer policy opts in', async () => {
        const config = parseMagicSsoConfigToml(
            source.replace('enabled = false', 'enabled = true\nbootstrapEnabled = true'),
            'fixture',
        );
        for (const version of [undefined, 1, 2]) {
            const fetcher = vi.fn<typeof fetch>(async () =>
                Response.json({
                    browserSso: {
                        ...fixture.enabled.browserSso,
                        ...(version === undefined ? {} : { appOwnedBootstrapVersion: version }),
                    },
                }),
            );
            const result = report();
            await checkDoctorBrowserSso(result, config, true, 1000, fetcher);
            expect(result.checks.at(-1)?.status).toBe(version === 1 ? 'pass' : 'fail');
        }
    });
});
