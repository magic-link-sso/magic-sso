// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Wojciech Polak

import { build } from 'esbuild';
import { SignJWT } from 'jose';
import { createRequire } from 'node:module';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const packageDirectory = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const secret = new TextEncoder().encode('worker-runtime-test-secret');
const require = createRequire(import.meta.url);

interface WorkerRuntime {
    dispatchFetch(url: string, init: { headers: Record<string, string> }): Promise<Response>;
    dispose(): Promise<void>;
}

interface WorkerRuntimeConstructor {
    new (options: {
        bindings: Record<string, string>;
        compatibilityDate: string;
        modules: true;
        script: string;
    }): WorkerRuntime;
}

async function loadWorkerRuntime(): Promise<WorkerRuntimeConstructor> {
    const runtimeModule: unknown = await import(require.resolve('miniflare'));

    if (
        typeof runtimeModule !== 'object' ||
        runtimeModule === null ||
        !('Miniflare' in runtimeModule)
    ) {
        throw new Error('Expected Miniflare to export a Worker runtime constructor.');
    }

    const candidate = runtimeModule.Miniflare;
    if (typeof candidate !== 'function') {
        throw new Error('Expected Miniflare to export a Worker runtime constructor.');
    }

    // The runtime shape is checked above; Miniflare's bundled declarations have incompatible peers.
    return candidate as WorkerRuntimeConstructor;
}

async function createAccessToken(): Promise<string> {
    return new SignJWT({
        email: 'worker@example.test',
        jti: 'worker-token-id',
        scope: '',
        siteId: 'site-worker',
    })
        .setProtectedHeader({ alg: 'HS256' })
        .setAudience('https://app.example.test')
        .setIssuer('https://sso.example.test')
        .setIssuedAt()
        .setExpirationTime('5m')
        .sign(secret);
}

describe('@magic-link-sso/core in a Worker runtime', () => {
    it('verifies a cookie session and creates a same-origin login target', async () => {
        const bundle = await build({
            bundle: true,
            entryPoints: [resolve(packageDirectory, 'test/fixtures/worker-runtime.mjs')],
            format: 'esm',
            outfile: 'worker.mjs',
            platform: 'browser',
            write: false,
        });
        const script = bundle.outputFiles[0]?.text;

        if (typeof script !== 'string') {
            throw new Error('Expected an esbuild Worker bundle.');
        }

        const WorkerRuntime = await loadWorkerRuntime();
        const miniflare = new WorkerRuntime({
            bindings: { JWT_SECRET: new TextDecoder().decode(secret) },
            compatibilityDate: '2026-08-06',
            modules: true,
            script,
        });

        try {
            const response = await miniflare.dispatchFetch('https://app.example.test/protected', {
                headers: { cookie: `magic-sso=${await createAccessToken()}` },
            });

            expect(response.status).toBe(200);
            await expect(response.json()).resolves.toEqual({
                email: 'worker@example.test',
                loginTarget: '/login?returnUrl=https%3A%2F%2Fapp.example.test%2Fprotected',
            });
        } finally {
            await miniflare.dispose();
        }
    });
});
