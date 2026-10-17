// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 Wojciech Polak

import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import Fastify, { type InjectOptions } from 'fastify';
import { afterEach, describe, expect, it } from 'vitest';
import { withManagerStateLock } from '../lock.js';
import { registerManagerMutationBoundary } from './mutations.js';

const directories: string[] = [];

function createLockFile(): string {
    const directory = mkdtempSync(join(tmpdir(), 'manager-http-boundary-'));
    directories.push(directory);
    return join(directory, 'manager.lock');
}

afterEach(() => {
    for (const directory of directories.splice(0)) {
        rmSync(directory, { recursive: true, force: true });
    }
});

describe('manager HTTP mutation boundary', () => {
    it('rejects independent writes inside another transaction while allowing reads', async () => {
        const app = Fastify();
        const lockFile = createLockFile();
        let writes = 0;
        registerManagerMutationBoundary(app, lockFile);
        // Separate route registrations share the boundary installed on the root app.
        app.post('/sites/client/scopes', async () => ++writes);
        app.put('/api/sites/client/scopes', async () => ++writes);
        app.patch('/api/sites/client/access/grants/person', async () => ++writes);
        app.delete('/api/sites/client/scopes/reports', async () => ++writes);
        app.get('/api/sites/client', async () => ({ writes }));

        try {
            await withManagerStateLock(lockFile, async () => {
                const mutations: InjectOptions[] = [
                    { method: 'POST', url: '/sites/client/scopes' },
                    { method: 'PUT', url: '/api/sites/client/scopes' },
                    { method: 'PATCH', url: '/api/sites/client/access/grants/person' },
                    { method: 'DELETE', url: '/api/sites/client/scopes/reports' },
                ];
                for (const mutation of mutations) {
                    const response = await app.inject(mutation);
                    expect(response.statusCode).toBe(409);
                    expect(response.json()).toMatchObject({ code: 'manager_busy' });
                }
                const read = await app.inject('/api/sites/client');
                expect(read.statusCode).toBe(200);
                expect(read.json()).toEqual({ writes: 0 });
            });
            const retry = await app.inject({ method: 'POST', url: '/sites/client/scopes' });
            expect(retry.statusCode).toBe(200);
            expect(writes).toBe(1);
            expect(existsSync(lockFile)).toBe(false);
        } finally {
            await app.close();
        }
    });

    it('holds the lock until an asynchronous handler completes and releases it after failure', async () => {
        const app = Fastify();
        const lockFile = createLockFile();
        registerManagerMutationBoundary(app, lockFile);
        app.post('/api/state/import', async () => {
            expect(existsSync(lockFile)).toBe(true);
            await Promise.resolve();
            expect(existsSync(lockFile)).toBe(true);
            throw new Error('Rejected import');
        });
        app.post('/reconcile/base', async () => ({ locked: existsSync(lockFile) }));
        try {
            const failed = await app.inject({ method: 'POST', url: '/api/state/import' });
            expect(failed.statusCode).toBe(500);
            expect(existsSync(lockFile)).toBe(false);
            const next = await app.inject({ method: 'POST', url: '/reconcile/base' });
            expect(next.statusCode).toBe(200);
            expect(next.json()).toEqual({ locked: true });
            expect(existsSync(lockFile)).toBe(false);
        } finally {
            await app.close();
        }
    });

    it('leaves session, validation, and apply routes in charge of their own locking', async () => {
        const app = Fastify();
        const lockFile = createLockFile();
        registerManagerMutationBoundary(app, lockFile);
        const paths = [
            '/login',
            '/logout',
            '/diff/validate',
            '/api/validate',
            '/diff/apply',
            '/api/apply',
        ];
        for (const url of paths) {
            app.post(url, async () => ({ locked: existsSync(lockFile) }));
        }
        try {
            for (const url of paths) {
                const response = await app.inject({ method: 'POST', url });
                expect(response.statusCode).toBe(200);
                expect(response.json()).toEqual({ locked: false });
            }
        } finally {
            await app.close();
        }
    });
});
