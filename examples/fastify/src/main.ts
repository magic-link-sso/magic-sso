// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Wojciech Polak

import 'dotenv/config';
import { createApp } from './app.js';

async function start(): Promise<void> {
    const port = Number.parseInt(process.env['PORT'] ?? '3005', 10);
    const app = await createApp();
    let shutdownPromise: Promise<void> | null = null;

    const shutdown = (signal: NodeJS.Signals): Promise<void> => {
        shutdownPromise ??= (async () => {
            app.log.info({ signal }, 'Shutting down');
            await app.close();
            process.exit(0);
        })();

        return shutdownPromise;
    };

    process.once('SIGINT', () => {
        void shutdown('SIGINT');
    });
    process.once('SIGTERM', () => {
        void shutdown('SIGTERM');
    });

    try {
        await app.listen({
            host: '0.0.0.0',
            port,
        });
        console.log(`Fastify example listening on http://localhost:${port}`);
    } catch (error) {
        app.log.error({ err: error }, 'Failed to start Fastify example');
        process.exit(1);
    }
}

void start();
