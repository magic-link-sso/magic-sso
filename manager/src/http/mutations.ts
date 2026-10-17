// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 Wojciech Polak

import type { FastifyInstance, FastifyRequest } from 'fastify';
import type { ManagerAuditEventKind } from '../apply.js';
import { recordManagerMutationAuditEvent } from '../audit.js';
import { withManagerStateLock } from '../lock.js';
import { buildManagerDiff, loadManagerStateOrEmpty, persistManagerState } from '../service.js';
import { detectConfigDrift } from '../runtime.js';
import type { ManagerRuntimeSettings } from '../settings.js';
import { createStatusError } from './errors.js';
import { createRequestAuditActor } from './security.js';
import type { ManagerRouteContext } from './context.js';

export function isUiEditingAllowed(
    driftStatus: ReturnType<typeof buildManagerDiff>['driftStatus'],
): boolean {
    return driftStatus?.baseConfigDrifted !== true;
}

function createUiDriftFreezeError(): ReturnType<typeof createStatusError> {
    return createStatusError(
        409,
        'Base config drift detected. UI write actions are frozen until magic-sso.base.toml is synced and applied again.',
        'base_config_drift',
    );
}

function createApiDriftFreezeError(): ReturnType<typeof createStatusError> {
    return createStatusError(
        409,
        'Base config drift detected. Manager access mutations are frozen until magic-sso.base.toml is synced and applied again.',
        'base_config_drift',
    );
}

export function assertUiEditingAllowed(settings: ManagerRuntimeSettings): void {
    const state = loadManagerStateOrEmpty(settings);
    const expectedBaseConfigHash = state.metadata.lastAppliedBaseConfigHash;
    const expectedRuntimeConfigHash = state.metadata.lastAppliedRuntimeConfigHash;
    const driftStatus =
        typeof expectedBaseConfigHash === 'string' && typeof expectedRuntimeConfigHash === 'string'
            ? detectConfigDrift(settings, expectedBaseConfigHash, expectedRuntimeConfigHash)
            : undefined;
    if (!isUiEditingAllowed(driftStatus)) {
        throw createUiDriftFreezeError();
    }
}

export function assertApiEditingAllowed(settings: ManagerRuntimeSettings): void {
    const state = loadManagerStateOrEmpty(settings);
    const expectedBaseConfigHash = state.metadata.lastAppliedBaseConfigHash;
    const expectedRuntimeConfigHash = state.metadata.lastAppliedRuntimeConfigHash;
    const driftStatus =
        typeof expectedBaseConfigHash === 'string' && typeof expectedRuntimeConfigHash === 'string'
            ? detectConfigDrift(settings, expectedBaseConfigHash, expectedRuntimeConfigHash)
            : undefined;
    if (!isUiEditingAllowed(driftStatus)) {
        throw createApiDriftFreezeError();
    }
}

/** Caller must hold the state lock from before loading state through this write. */
export function persistAuditedMutation(
    options: ManagerRouteContext,
    request: FastifyRequest,
    nextState: Parameters<typeof persistManagerState>[1],
    mutation: {
        changedSiteIds: string[];
        kind: Exclude<ManagerAuditEventKind, 'apply-failed' | 'apply-succeeded'>;
        message: string;
    },
): ReturnType<typeof persistManagerState> {
    const { settings } = options;
    const persistedState = persistManagerState(settings, nextState);
    recordManagerMutationAuditEvent(persistedState, settings, {
        actor: createRequestAuditActor(request),
        changedSiteIds: mutation.changedSiteIds,
        kind: mutation.kind,
        message: mutation.message,
        now: options.now,
    });
    return persistedState;
}

/** Install before route groups so state is loaded and persisted under one lock. */
export function registerManagerMutationBoundary(app: FastifyInstance, lockFile: string): void {
    app.addHook('onRoute', (routeOptions) => {
        const methods = Array.isArray(routeOptions.method)
            ? routeOptions.method
            : [routeOptions.method];
        if (
            methods.some((method) => ['POST', 'PUT', 'PATCH', 'DELETE'].includes(method)) &&
            ![
                '/login',
                '/logout',
                '/diff/validate',
                '/api/validate',
                '/diff/apply',
                '/api/apply',
            ].includes(routeOptions.url)
        ) {
            const handler = routeOptions.handler;
            routeOptions.handler = async function (request, reply): Promise<unknown> {
                return withManagerStateLock(
                    lockFile,
                    async () => handler.call(this, request, reply),
                    { independent: true },
                );
            };
        }
    });
}
