// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Wojciech Polak

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
    config: {
        mode: 'path-prefix' | 'subdomain';
        namespaceRoot: string;
        port: number;
        publicOrigin: string;
        upstreamUrl: string;
    };
    createAppSpy: ReturnType<typeof vi.fn>;
    exitSpy: ReturnType<typeof vi.spyOn>;
    loadConfigSpy: ReturnType<typeof vi.fn>;
    processHandlers: Map<NodeJS.Signals, () => void>;
    readConfigFilePathSpy: ReturnType<typeof vi.fn>;
}

async function importMainWithMocks(
    options: {
        listenError?: Error;
    } = {},
): Promise<MainModuleHarness> {
    vi.resetModules();

    const config = {
        mode: 'subdomain' as const,
        namespaceRoot: '/_magicgate',
        port: 43106,
        publicOrigin: 'http://private.example.com',
        upstreamUrl: 'http://private-upstream.internal',
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

    const createAppSpy = vi.fn(async () => app);
    const loadConfigSpy = vi.fn(() => config);
    const readConfigFilePathSpy = vi.fn(() => '/tmp/magic-gate.toml');

    vi.doMock('../src/app.js', () => ({
        createApp: createAppSpy,
    }));
    vi.doMock('../src/config.js', () => ({
        loadConfig: loadConfigSpy,
        readConfigFilePath: readConfigFilePathSpy,
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
        return undefined as never;
    });

    await import('../src/main.js');

    return {
        app,
        config,
        createAppSpy,
        exitSpy,
        loadConfigSpy,
        processHandlers,
        readConfigFilePathSpy,
    };
}

describe('main entrypoint', () => {
    afterEach(() => {
        vi.restoreAllMocks();
        vi.resetModules();
    });

    it('starts the gate with the loaded TOML config and logs the config file path', async () => {
        const harness = await importMainWithMocks();

        await vi.waitFor(() => {
            expect(harness.app.listen).toHaveBeenCalledWith({
                host: '0.0.0.0',
                port: harness.config.port,
            });
        });

        expect(harness.readConfigFilePathSpy).toHaveBeenCalledOnce();
        expect(harness.loadConfigSpy).toHaveBeenCalledOnce();
        expect(harness.createAppSpy).toHaveBeenCalledWith({
            config: harness.config,
        });
        expect(harness.app.log.info).toHaveBeenCalledWith(
            {
                configFilePath: '/tmp/magic-gate.toml',
                mode: harness.config.mode,
                namespace: harness.config.namespaceRoot,
                port: harness.config.port,
                publicOrigin: harness.config.publicOrigin,
                upstreamUrl: harness.config.upstreamUrl,
            },
            'Gate is running with TOML config',
        );
        expect(harness.exitSpy).not.toHaveBeenCalled();
    });

    it('logs and exits when listen fails before the gate starts', async () => {
        const listenError = new Error('port already in use');
        const harness = await importMainWithMocks({
            listenError,
        });

        await vi.waitFor(() => {
            expect(harness.exitSpy).toHaveBeenCalledWith(1);
        });

        expect(harness.app.log.error).toHaveBeenCalledWith(
            { err: listenError },
            'Failed to start gate',
        );
    });

    it('registers signal handlers that close the app and exit cleanly', async () => {
        const harness = await importMainWithMocks();

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
