/**
 * server/src/startupProbe.ts
 *
 * Magic Link SSO Copyright (C) 2026 Wojciech Polak
 *
 * This program is free software; you can redistribute it and/or modify it
 * under the terms of the GNU General Public License as published by the
 * Free Software Foundation; either version 3 of the License, or (at your
 * option) any later version.
 *
 * This program is distributed in the hope that it will be useful,
 * but WITHOUT ANY WARRANTY; without even the implied warranty of
 * MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE. See the
 * GNU General Public License for more details.
 *
 * You should have received a copy of the GNU General Public License along
 * with this program. If not, see <https://www.gnu.org/licenses/>.
 */

const startupProbeHeaderName = 'x-magic-sso-startup-probe';

export interface StartupProbeOptions {
    appUrl: string;
    fetchImpl?: typeof fetch;
    startupProbeToken: string;
}

function isLoopbackHostname(hostname: string): boolean {
    return (
        hostname === 'localhost' ||
        hostname === '127.0.0.1' ||
        hostname === '::1' ||
        hostname === '[::1]'
    );
}

export function shouldVerifyStartupAppUrl(appUrl: string): boolean {
    try {
        return isLoopbackHostname(new URL(appUrl).hostname);
    } catch {
        return false;
    }
}

export function getStartupProbeHeaderName(): string {
    return startupProbeHeaderName;
}

export async function verifyStartupAppUrl(options: StartupProbeOptions): Promise<void> {
    const healthcheckUrl = new URL('/healthz', options.appUrl);
    const fetchImpl = options.fetchImpl ?? fetch;

    let response: Response;
    try {
        response = await fetchImpl(healthcheckUrl, {
            cache: 'no-store',
            headers: {
                accept: 'application/json',
            },
        });
    } catch (error: unknown) {
        const message = error instanceof Error ? error.message : String(error);
        throw new Error(
            `Startup verification failed for ${healthcheckUrl.toString()}: ${message}. Another process may already be serving ${new URL(options.appUrl).origin}.`,
        );
    }

    const payload = (await response.json().catch(() => null)) as unknown;
    const probeHeader = response.headers.get(startupProbeHeaderName);
    const hasOkPayload =
        typeof payload === 'object' &&
        payload !== null &&
        'status' in payload &&
        payload.status === 'ok';

    if (!response.ok || !hasOkPayload || probeHeader !== options.startupProbeToken) {
        throw new Error(
            `Startup verification failed for ${healthcheckUrl.toString()}: expected this Magic Link SSO instance to answer, but received a different response. Another process may already be serving ${new URL(options.appUrl).origin}.`,
        );
    }
}
