/**
 * server/src/main.test.ts
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

import { afterEach, describe, expect, it, vi } from 'vitest';

interface FakeApp {
    close: ReturnType<typeof vi.fn<() => Promise<void>>>;
    listen: ReturnType<typeof vi.fn<() => Promise<void>>>;
    log: {
        error: ReturnType<typeof vi.fn>;
        info: ReturnType<typeof vi.fn>;
    };
}

interface MainModuleHarness {
    app: FakeApp;
    buildAppSpy: ReturnType<typeof vi.fn>;
    config: {
        appPort: number;
        appUrl: string;
        sites: Array<{ id: string }>;
    };
    exitSpy: ReturnType<typeof vi.spyOn>;
    processHandlers: Map<NodeJS.Signals, () => void>;
    readConfigFilePathSpy: ReturnType<typeof vi.fn>;
    shouldVerifyStartupAppUrlSpy: ReturnType<typeof vi.fn>;
    verifyStartupAppUrlSpy: ReturnType<typeof vi.fn>;
}

async function importMainWithMocks(
    options: {
        appUrl?: string;
        listenError?: Error;
        shouldVerifyStartupAppUrl?: boolean;
        verifyStartupAppUrlError?: Error;
    } = {},
): Promise<MainModuleHarness> {
    vi.resetModules();

    const config = {
        appPort: 4310,
        appUrl: options.appUrl ?? 'http://localhost:4310',
        sites: [{ id: 'client' }, { id: 'admin' }],
    };

    const app: FakeApp = {
        close: vi.fn(async () => undefined),
        listen: vi.fn(async () => undefined),
        log: {
            error: vi.fn(),
            info: vi.fn(),
        },
    };

    if (typeof options.listenError !== 'undefined') {
        app.listen.mockRejectedValue(options.listenError);
    }

    const buildAppSpy = vi.fn(async () => app);
    const readConfigFilePathSpy = vi.fn(() => '/tmp/magic-sso.toml');
    const shouldVerifyStartupAppUrlSpy = vi.fn(() => options.shouldVerifyStartupAppUrl ?? true);
    const verifyStartupAppUrlSpy = vi.fn(async () => undefined);

    if (typeof options.verifyStartupAppUrlError !== 'undefined') {
        verifyStartupAppUrlSpy.mockRejectedValue(options.verifyStartupAppUrlError);
    }

    vi.doMock('./app.js', () => ({
        buildApp: buildAppSpy,
    }));
    vi.doMock('./config.js', () => ({
        loadConfig: () => config,
        readConfigFilePath: readConfigFilePathSpy,
    }));
    vi.doMock('./startupProbe.js', () => ({
        shouldVerifyStartupAppUrl: shouldVerifyStartupAppUrlSpy,
        verifyStartupAppUrl: verifyStartupAppUrlSpy,
    }));
    vi.doMock('node:crypto', () => ({
        randomUUID: () => 'startup-probe-token',
    }));

    const processHandlers = new Map<NodeJS.Signals, () => void>();
    vi.spyOn(process, 'on').mockImplementation((event, listener) => {
        if (event === 'SIGINT' || event === 'SIGTERM') {
            processHandlers.set(event, () => {
                listener(event);
            });
        }

        return process;
    });

    const exitSpy = vi.spyOn(process, 'exit').mockImplementation((code) => {
        void code;

        // The real process.exit() returns never. Tests replace it with a no-op
        // so the entrypoint can be exercised without terminating Vitest.
        return undefined as never;
    });

    await import('./main.js');

    return {
        app,
        buildAppSpy,
        config,
        exitSpy,
        processHandlers,
        readConfigFilePathSpy,
        shouldVerifyStartupAppUrlSpy,
        verifyStartupAppUrlSpy,
    };
}

describe('main entrypoint', () => {
    afterEach(() => {
        vi.restoreAllMocks();
        vi.resetModules();
    });

    it('starts the server, verifies loopback app URLs, and logs the loaded config', async () => {
        const harness = await importMainWithMocks();

        await vi.waitFor(() => {
            expect(harness.app.listen).toHaveBeenCalledWith({
                host: '0.0.0.0',
                port: harness.config.appPort,
            });
            expect(harness.verifyStartupAppUrlSpy).toHaveBeenCalledWith({
                appUrl: harness.config.appUrl,
                startupProbeToken: 'startup-probe-token',
            });
        });

        expect(harness.buildAppSpy).toHaveBeenCalledWith({
            config: harness.config,
            startupProbeToken: 'startup-probe-token',
        });
        expect(harness.readConfigFilePathSpy).toHaveBeenCalledOnce();
        expect(harness.shouldVerifyStartupAppUrlSpy).toHaveBeenCalledWith(harness.config.appUrl);
        expect(harness.app.log.info).toHaveBeenCalledWith(
            {
                appUrl: harness.config.appUrl,
                configFilePath: '/tmp/magic-sso.toml',
                port: harness.config.appPort,
                siteIds: ['client', 'admin'],
            },
            'Server is running with TOML config',
        );
        expect(harness.exitSpy).not.toHaveBeenCalled();
    });

    it('logs, closes the app, and exits when startup verification fails', async () => {
        const startupProbeError = new Error('another process answered');
        const harness = await importMainWithMocks({
            verifyStartupAppUrlError: startupProbeError,
        });

        await vi.waitFor(() => {
            expect(harness.app.close).toHaveBeenCalledOnce();
            expect(harness.exitSpy).toHaveBeenCalledWith(1);
        });

        expect(harness.app.log.error).toHaveBeenCalledWith(
            { err: startupProbeError },
            'Configured appUrl does not reach this server instance',
        );
    });

    it('logs and exits when listen fails before the server starts', async () => {
        const listenError = new Error('port already in use');
        const harness = await importMainWithMocks({
            listenError,
            shouldVerifyStartupAppUrl: false,
        });

        await vi.waitFor(() => {
            expect(harness.exitSpy).toHaveBeenCalledWith(1);
        });

        expect(harness.shouldVerifyStartupAppUrlSpy).not.toHaveBeenCalled();
        expect(harness.verifyStartupAppUrlSpy).not.toHaveBeenCalled();
        expect(harness.app.log.error).toHaveBeenCalledWith(
            { err: listenError },
            'Failed to start server',
        );
    });

    it('registers signal handlers that close the app and exit cleanly', async () => {
        const harness = await importMainWithMocks({
            shouldVerifyStartupAppUrl: false,
        });

        await vi.waitFor(() => {
            expect(harness.app.listen).toHaveBeenCalledOnce();
            expect(harness.processHandlers.get('SIGINT')).toBeTypeOf('function');
            expect(harness.processHandlers.get('SIGTERM')).toBeTypeOf('function');
        });

        harness.processHandlers.get('SIGINT')?.();
        await vi.waitFor(() => {
            expect(harness.app.close).toHaveBeenCalledTimes(1);
            expect(harness.exitSpy).toHaveBeenCalledWith(0);
        });

        harness.processHandlers.get('SIGTERM')?.();
        await vi.waitFor(() => {
            expect(harness.app.close).toHaveBeenCalledTimes(2);
        });

        expect(harness.app.log.info).toHaveBeenCalledWith({ signal: 'SIGINT' }, 'Shutting down');
        expect(harness.app.log.info).toHaveBeenCalledWith({ signal: 'SIGTERM' }, 'Shutting down');
    });
});
