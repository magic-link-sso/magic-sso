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
    createAppSpy: ReturnType<typeof vi.fn>;
    exitSpy: ReturnType<typeof vi.spyOn>;
    processHandlers: Map<NodeJS.Signals, () => void>;
}

async function importMainWithMocks(
    options: {
        listenError?: Error;
        port?: string;
    } = {},
): Promise<MainModuleHarness> {
    vi.resetModules();

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
    vi.doMock('../src/app.js', () => ({
        createApp: createAppSpy,
    }));

    const processHandlers = new Map<NodeJS.Signals, () => void>();
    vi.spyOn(process, 'once').mockImplementation((event, listener) => {
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

    const consoleLogSpy = vi.spyOn(console, 'log').mockImplementation(() => undefined);

    process.env['PORT'] = options.port ?? '3015';

    await import('../src/main.js');

    consoleLogSpy.mockRestore();

    return {
        app,
        createAppSpy,
        exitSpy,
        processHandlers,
    };
}

describe('fastify main entrypoint', () => {
    afterEach(() => {
        vi.restoreAllMocks();
        vi.resetModules();
        delete process.env['PORT'];
    });

    it('starts the app on the configured port', async () => {
        const harness = await importMainWithMocks({
            port: '3123',
        });

        await vi.waitFor(() => {
            expect(harness.createAppSpy).toHaveBeenCalledOnce();
            expect(harness.app.listen).toHaveBeenCalledWith({
                host: '0.0.0.0',
                port: 3123,
            });
        });

        expect(harness.exitSpy).not.toHaveBeenCalled();
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
            expect(harness.app.close).toHaveBeenCalledTimes(1);
        });

        expect(harness.app.log.info).toHaveBeenCalledWith({ signal: 'SIGINT' }, 'Shutting down');
    });

    it('logs and exits when the app fails to start', async () => {
        const listenError = new Error('port already in use');
        const harness = await importMainWithMocks({
            listenError,
        });

        await vi.waitFor(() => {
            expect(harness.exitSpy).toHaveBeenCalledWith(1);
        });

        expect(harness.app.log.error).toHaveBeenCalledWith(
            { err: listenError },
            'Failed to start Fastify example',
        );
    });
});
