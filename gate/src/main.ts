// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Wojciech Polak

import 'dotenv/config';
import { createApp } from './app.js';
import { loadConfig, readConfigFilePath } from './config.js';

const configFilePath = readConfigFilePath();
const config = loadConfig();
const app = await createApp({ config });

const shutdown = async (signal: NodeJS.Signals): Promise<void> => {
    app.log.info({ signal }, 'Shutting down');
    await app.close();
    process.exit(0);
};

process.on('SIGINT', () => {
    void shutdown('SIGINT');
});
process.on('SIGTERM', () => {
    void shutdown('SIGTERM');
});

try {
    await app.listen({
        host: '0.0.0.0',
        port: config.port,
    });

    app.log.info(
        {
            configFilePath,
            mode: config.mode,
            namespace: config.namespaceRoot,
            port: config.port,
            publicOrigin: config.publicOrigin,
            upstreamUrl: config.upstreamUrl,
        },
        'Gate is running with TOML config',
    );
} catch (error) {
    app.log.error({ err: error }, 'Failed to start gate');
    process.exit(1);
}
