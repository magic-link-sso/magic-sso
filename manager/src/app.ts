// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 Wojciech Polak

import Fastify, { type FastifyInstance, type FastifyServerOptions } from 'fastify';
import {
    assertManagerAuditConfig,
    assertReloadSecretIsNotPlaceholder,
    loadManagerRuntimeSettings,
    type ManagerRuntimeSettings,
} from './settings.js';
import { registerManagerErrorHandler } from './http/errors.js';
import { registerManagerHttpSecurity } from './http/security.js';
import { registerManagerMutationBoundary } from './http/mutations.js';
import { registerManagerSessionRoutes } from './routes/session.js';
import { registerManagerSiteUiRoutes } from './routes/sites-ui.js';
import { registerManagerPeopleUiRoutes } from './routes/people-ui.js';
import { registerManagerOperationUiRoutes } from './routes/operations-ui.js';
import { registerManagerSiteApiRoutes } from './routes/sites-api.js';
import { registerManagerOperationApiRoutes } from './routes/operations-api.js';
export { MANAGER_SESSION_COOKIE_NAME } from './http/security.js';

export interface BuildAppOptions {
    fetchImplementation?: typeof fetch | undefined;
    logger?: FastifyServerOptions['logger'];
    now?: Date | undefined;
    settings?: ManagerRuntimeSettings | undefined;
}

export async function buildApp(options: BuildAppOptions = {}): Promise<FastifyInstance> {
    const settings = options.settings ?? loadManagerRuntimeSettings();
    assertManagerAuditConfig(settings);
    assertReloadSecretIsNotPlaceholder(settings);
    if (typeof settings.service === 'undefined') {
        throw new Error(
            'Manager service settings are not configured. Add [service] to MAGICSSO_MANAGER_CONFIG_FILE.',
        );
    }

    const app = Fastify({
        logger: options.logger ?? true,
        trustProxy: settings.service.trustProxy ?? false,
    });

    app.addContentTypeParser(
        'application/x-www-form-urlencoded',
        { parseAs: 'string' },
        (_request, body, done) => {
            done(
                null,
                Object.fromEntries(new URLSearchParams(typeof body === 'string' ? body : '')),
            );
        },
    );

    registerManagerMutationBoundary(app, settings.paths.lockFile);
    await registerManagerHttpSecurity(app, settings);
    registerManagerErrorHandler(app);

    app.get('/healthz', async (): Promise<{ managedSiteCount: number; status: 'ok' }> => ({
        managedSiteCount: settings.managedSiteIds.length,
        status: 'ok',
    }));

    const context = { ...options, settings };
    registerManagerSessionRoutes(app, context);
    registerManagerSiteUiRoutes(app, context);
    registerManagerPeopleUiRoutes(app, context);
    registerManagerOperationUiRoutes(app, context);
    registerManagerSiteApiRoutes(app, context);
    registerManagerOperationApiRoutes(app, context);
    return app;
}
