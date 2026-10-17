// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 Wojciech Polak

import { z } from 'zod';
import { applyManagerState, reloadManagerRuntime, type ManagerReloadResult } from '../apply.js';
import {
    buildManagerDiff,
    buildManagerReconcilePreview,
    buildManagerReconcileStatus,
    exportPortableManagerStateSnapshot,
    listManagerAuditEvents,
    loadManagerStateOrEmpty,
    previewPortableManagerStateImport,
} from '../service.js';
import { parsePortableManagerStateSnapshotJson } from '../state.js';
import { createRequestAuditActor } from '../http/security.js';
import { createStatusError, getErrorStatusCode, mapRouteError } from '../http/errors.js';
import { persistAuditedMutation } from '../http/mutations.js';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import type { ManagerRouteContext } from '../http/context.js';

export function registerManagerOperationApiRoutes(
    app: FastifyInstance,
    options: ManagerRouteContext,
): void {
    const { settings } = options;
    const stateImportSchema = z
        .object({
            state: z.unknown(),
        })
        .strict();

    const reconcileSourceSchema = z.enum(['base', 'runtime']);

    function parseAuditLimit(value: unknown): number | undefined {
        if (typeof value === 'undefined') {
            return undefined;
        }

        if (typeof value !== 'string' || !/^\d+$/.test(value)) {
            throw createStatusError(400, 'Query parameter "limit" must be a positive integer.');
        }

        const parsedValue = Number.parseInt(value, 10);
        if (parsedValue < 1) {
            throw createStatusError(400, 'Query parameter "limit" must be a positive integer.');
        }

        return parsedValue;
    }

    function parsePortableStateImportBody(
        body: unknown,
    ): ReturnType<typeof parsePortableManagerStateSnapshotJson> {
        const parsedBody = stateImportSchema.parse(body);
        return parsePortableManagerStateSnapshotJson(
            JSON.stringify(parsedBody.state),
            'request body state',
        );
    }

    app.get('/api/diff', async (): Promise<{ diff: ReturnType<typeof buildManagerDiff> }> => {
        const state = loadManagerStateOrEmpty(settings);
        return {
            diff: buildManagerDiff(state, settings),
        };
    });

    app.get(
        '/api/state/export',
        async (): Promise<{ state: ReturnType<typeof exportPortableManagerStateSnapshot> }> => {
            const state = loadManagerStateOrEmpty(settings);
            return {
                state: exportPortableManagerStateSnapshot(state),
            };
        },
    );

    app.post(
        '/api/state/import',
        async (
            request: FastifyRequest<{ Body: z.infer<typeof stateImportSchema> }>,
        ): Promise<{
            changedSiteIds: string[];
            diff: ReturnType<typeof previewPortableManagerStateImport>['diff'];
            state: ReturnType<typeof exportPortableManagerStateSnapshot>;
        }> => {
            try {
                const state = loadManagerStateOrEmpty(settings);
                const snapshot = parsePortableStateImportBody(request.body);
                const preview = previewPortableManagerStateImport(state, settings, snapshot);
                const persistedState = persistAuditedMutation(options, request, preview.state, {
                    changedSiteIds: preview.changedSiteIds,
                    kind: 'state-imported',
                    message: 'Imported portable manager state and reset apply metadata.',
                });
                return {
                    changedSiteIds: preview.changedSiteIds,
                    diff: preview.diff,
                    state: exportPortableManagerStateSnapshot(persistedState),
                };
            } catch (error) {
                const message = error instanceof Error ? error.message : String(error);
                throw createStatusError(400, message, 'invalid_state_import');
            }
        },
    );

    app.get(
        '/api/reconcile',
        async (): Promise<{
            base: ReturnType<typeof buildManagerReconcileStatus>['base'];
            driftStatus: ReturnType<typeof buildManagerReconcileStatus>['driftStatus'];
            runtime: ReturnType<typeof buildManagerReconcileStatus>['runtime'];
        }> => {
            const state = loadManagerStateOrEmpty(settings);
            const reconcileStatus = buildManagerReconcileStatus(state, settings);
            return {
                base: reconcileStatus.base,
                driftStatus: reconcileStatus.driftStatus,
                runtime: reconcileStatus.runtime,
            };
        },
    );

    app.post(
        '/api/reconcile/:source',
        async (
            request: FastifyRequest<{ Params: { source: string } }>,
        ): Promise<{
            changedSiteIds: string[];
            diff: ReturnType<typeof buildManagerReconcilePreview>['diff'];
            source: z.infer<typeof reconcileSourceSchema>;
            state: ReturnType<typeof exportPortableManagerStateSnapshot>;
        }> => {
            try {
                const source = reconcileSourceSchema.parse(request.params.source);
                const state = loadManagerStateOrEmpty(settings);
                const preview = buildManagerReconcilePreview(state, settings, source);
                const persistedState = persistAuditedMutation(options, request, preview.state, {
                    changedSiteIds: preview.changedSiteIds,
                    kind: 'state-reconciled',
                    message: `Reconciled manager state from the ${source} config and reset apply metadata.`,
                });
                return {
                    changedSiteIds: preview.changedSiteIds,
                    diff: preview.diff,
                    source,
                    state: exportPortableManagerStateSnapshot(persistedState),
                };
            } catch (error) {
                const routeError = mapRouteError(error);
                throw createStatusError(
                    getErrorStatusCode(routeError, 400),
                    routeError.message,
                    'reconcile_failed',
                );
            }
        },
    );

    app.get(
        '/api/audit',
        async (
            request: FastifyRequest<{ Querystring: { limit?: string } }>,
        ): Promise<{ events: ReturnType<typeof listManagerAuditEvents> }> => {
            const limit = parseAuditLimit(request.query.limit);
            return {
                events: listManagerAuditEvents(settings, { limit }),
            };
        },
    );
    app.post(
        '/api/validate',
        async (): Promise<{
            validation: {
                diff: ReturnType<typeof buildManagerDiff>;
                runtimeConfigFile: string;
                runtimeConfigHash: string;
                valid: true;
            };
        }> => {
            const state = loadManagerStateOrEmpty(settings);
            try {
                const diff = buildManagerDiff(state, settings);
                return {
                    validation: {
                        diff,
                        runtimeConfigFile: settings.paths.runtimeConfigFile,
                        runtimeConfigHash: diff.runtimePlan.runtimeConfigHash,
                        valid: true,
                    },
                };
            } catch (error) {
                const message = error instanceof Error ? error.message : String(error);
                throw createStatusError(400, message, 'runtime_validation_failed', {
                    runtimeConfigFile: settings.paths.runtimeConfigFile,
                });
            }
        },
    );

    app.post(
        '/api/apply',
        async (
            request: FastifyRequest,
        ): Promise<{
            apply: {
                auditEvent: Awaited<ReturnType<typeof applyManagerState>>['auditEvent'];
                auditPersisted: boolean;
                driftStatus?: Awaited<ReturnType<typeof applyManagerState>>['driftStatus'];
                reloadResult?: Awaited<ReturnType<typeof applyManagerState>>['reloadResult'];
                runtimeConfigFile: string;
                runtimeConfigHash: string;
            };
        }> => {
            const state = loadManagerStateOrEmpty(settings);
            try {
                const result = await applyManagerState(
                    () => loadManagerStateOrEmpty(settings),
                    settings,
                    {
                        actor: createRequestAuditActor(request),
                        fetchImplementation: options.fetchImplementation,
                        now: options.now,
                    },
                );
                return {
                    apply: {
                        auditEvent: result.auditEvent,
                        auditPersisted: result.auditPersisted,
                        driftStatus: result.driftStatus,
                        reloadResult: result.reloadResult,
                        runtimeConfigFile: settings.paths.runtimeConfigFile,
                        runtimeConfigHash: result.runtimePlan.runtimeConfigHash,
                    },
                };
            } catch (error) {
                const message = error instanceof Error ? error.message : String(error);
                if (
                    message ===
                    'Base config drift detected. Reconcile magic-sso.base.toml before running apply again.'
                ) {
                    throw createStatusError(409, message, 'base_config_drift', {
                        driftStatus: buildManagerDiff(state, settings).driftStatus,
                    });
                }

                if (message.startsWith('Another manager write is already in progress:')) {
                    throw createStatusError(409, message, 'apply_in_progress');
                }

                if (
                    message.startsWith('Failed to reach the server reload endpoint:') ||
                    message.startsWith('Server reload failed:')
                ) {
                    throw createStatusError(502, message, 'reload_failed', {
                        reloadUrl: settings.reload?.url,
                    });
                }

                throw createStatusError(400, message, 'apply_failed');
            }
        },
    );

    app.post('/api/reload', async (): Promise<{ reload: ManagerReloadResult }> => {
        try {
            return {
                reload: await reloadManagerRuntime(settings, {
                    fetchImplementation: options.fetchImplementation,
                }),
            };
        } catch (error) {
            const message = error instanceof Error ? error.message : String(error);
            if (
                message ===
                'Manager reload target is not configured. Add [reload] to MAGICSSO_MANAGER_CONFIG_FILE.'
            ) {
                throw createStatusError(400, message, 'reload_not_configured');
            }

            if (
                message.startsWith('Failed to reach the server reload endpoint:') ||
                message.startsWith('Server reload failed:') ||
                message === 'Server reload returned an unexpected response body.'
            ) {
                throw createStatusError(502, message, 'reload_failed', {
                    reloadUrl: settings.reload?.url,
                });
            }

            throw createStatusError(400, message, 'reload_failed');
        }
    });
}
