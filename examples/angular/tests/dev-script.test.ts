// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Wojciech Polak

import { EventEmitter } from 'node:events';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { runDev } from '../scripts/dev.mjs';

interface ProcessLike {
    env: NodeJS.ProcessEnv;
    on(event: NodeJS.Signals, listener: () => void): ProcessLike;
    removeListener(event: NodeJS.Signals, listener: () => void): ProcessLike;
}

class FakeChild extends EventEmitter {
    readonly kill = vi.fn((signal?: NodeJS.Signals) => {
        void signal;
        return true;
    });
}

function createFakeProcess(): ProcessLike & { handlers: Map<NodeJS.Signals, () => void> } {
    const handlers = new Map<NodeJS.Signals, () => void>();

    return {
        env: {},
        handlers,
        on(event, listener) {
            handlers.set(event, listener);
            return this;
        },
        removeListener(event, listener) {
            if (handlers.get(event) === listener) {
                handlers.delete(event);
            }

            return this;
        },
    };
}

describe('Angular dev script', () => {
    beforeEach(() => {
        vi.restoreAllMocks();
    });

    it('builds the Angular package before starting ng serve', async () => {
        const fakeProcess = createFakeProcess();
        const child = new FakeChild();
        const spawnSyncFn = vi.fn(() => ({
            signal: null,
            status: 0,
        }));
        const spawnFn = vi.fn(() => child);

        const promise = runDev({
            processObject: fakeProcess,
            spawnFn,
            spawnSyncFn,
        });

        child.emit('exit', 0, null);

        await expect(promise).resolves.toBe(0);
        expect(spawnSyncFn).toHaveBeenCalledWith(
            'pnpm',
            ['--filter', '@magic-link-sso/angular', 'build'],
            {
                env: fakeProcess.env,
                stdio: 'inherit',
            },
        );
        expect(spawnFn).toHaveBeenCalledWith(
            'ng',
            ['serve', '--host', '0.0.0.0', '--port', '3004'],
            {
                env: fakeProcess.env,
                stdio: 'inherit',
            },
        );
    });

    it('forwards SIGINT to ng serve and treats the interrupt as a clean exit', async () => {
        const fakeProcess = createFakeProcess();
        const child = new FakeChild();
        const spawnSyncFn = vi.fn(() => ({
            signal: null,
            status: 0,
        }));
        const spawnFn = vi.fn(() => child);

        const promise = runDev({
            processObject: fakeProcess,
            spawnFn,
            spawnSyncFn,
        });

        fakeProcess.handlers.get('SIGINT')?.();
        child.emit('exit', null, 'SIGINT');

        await expect(promise).resolves.toBe(0);
        expect(child.kill).toHaveBeenCalledWith('SIGINT');
    });
});
