// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 Wojciech Polak

import { z } from 'zod';
import { applyManagerState } from '../apply.js';
import {
    buildManagerDiff,
    buildManagerReconcilePreview,
    listManagedSites,
    listManagerAuditEvents,
    loadManagerStateOrEmpty,
    previewPortableManagerStateImport,
} from '../service.js';
import { parsePortableManagerStateSnapshotJson } from '../state.js';
import { renderManagerAuditPage, renderManagerDashboardPage } from '../ui.js';
import {
    buildUiSignOutPath,
    createRequestAuditActor,
    requireSameOriginFormPost,
    requireUiSession,
} from '../http/security.js';
import {
    createStatusError,
    getErrorStatusCode,
    mapRouteError,
    renderUiFailure,
} from '../http/errors.js';
import { persistAuditedMutation } from '../http/mutations.js';
import {
    buildUiNoticePath,
    classifyApplyFailure,
    getUiNotice,
    readFormField,
    renderDiffPage,
    renderReconcilePage,
} from '../http/ui.js';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import type { ManagerRouteContext } from '../http/context.js';

export function registerManagerOperationUiRoutes(
    app: FastifyInstance,
    options: ManagerRouteContext,
): void {
    const { settings } = options;
    const reconcileSourceSchema = z.enum(['base', 'runtime']);

    app.get(
        '/',
        async (
            request: FastifyRequest<{ Querystring: { kind?: string; notice?: string } }>,
            reply,
        ): Promise<void> => {
            if (!(await requireUiSession(request, reply, settings))) {
                return;
            }

            try {
                const state = loadManagerStateOrEmpty(settings);
                const diff = buildManagerDiff(state, settings);
                const changedSiteIds = new Set(
                    diff.summary.changedSites.map((site) => site.siteId),
                );
                reply.type('text/html; charset=utf-8').send(
                    renderManagerDashboardPage({
                        driftStatus: diff.driftStatus,
                        lastAppliedAt: state.metadata.lastAppliedAt,
                        notice: getUiNotice(request.query),
                        recentAuditEvents: listManagerAuditEvents(settings, { limit: 6 }),
                        signOutPath: buildUiSignOutPath(settings),
                        sites: listManagedSites(state, settings).map((site) => ({
                            ...site,
                            pendingChanges: changedSiteIds.has(site.id),
                        })),
                    }),
                );
            } catch (error) {
                const message = error instanceof Error ? error.message : String(error);
                renderUiFailure(reply, 500, 'Failed to load the manager dashboard.', message);
            }
        },
    );
    app.get(
        '/diff',
        async (
            request: FastifyRequest<{ Querystring: { kind?: string; notice?: string } }>,
            reply,
        ): Promise<void> => {
            if (!(await requireUiSession(request, reply, settings))) {
                return;
            }

            try {
                renderDiffPage(reply, settings, getUiNotice(request.query));
            } catch (error) {
                const message = error instanceof Error ? error.message : String(error);
                renderUiFailure(reply, 500, 'Failed to render the runtime diff.', message);
            }
        },
    );

    app.get(
        '/reconcile',
        async (
            request: FastifyRequest<{ Querystring: { kind?: string; notice?: string } }>,
            reply,
        ): Promise<void> => {
            if (!(await requireUiSession(request, reply, settings))) {
                return;
            }

            try {
                renderReconcilePage(reply, settings, getUiNotice(request.query));
            } catch (error) {
                const message = error instanceof Error ? error.message : String(error);
                renderUiFailure(reply, 500, 'Failed to render the reconcile tools.', message);
            }
        },
    );

    app.post('/diff/validate', async (request: FastifyRequest, reply): Promise<void> => {
        if (!(await requireUiSession(request, reply, settings))) {
            return;
        }

        requireSameOriginFormPost(request);

        try {
            const state = loadManagerStateOrEmpty(settings);
            const diff = buildManagerDiff(state, settings);
            const changedSiteCount = diff.summary.changedSites.length;
            reply.redirect(
                buildUiNoticePath('/diff', {
                    kind: 'success',
                    text: diff.summary.hasChanges
                        ? `Validated runtime plan for ${changedSiteCount} changed site${changedSiteCount === 1 ? '' : 's'}.`
                        : 'Validated runtime plan with no pending managed access changes.',
                }),
                303,
            );
        } catch (error) {
            const message = error instanceof Error ? error.message : String(error);
            renderUiFailure(reply, 400, 'Failed to validate the runtime plan.', message);
        }
    });

    app.post('/diff/apply', async (request: FastifyRequest, reply): Promise<void> => {
        if (!(await requireUiSession(request, reply, settings))) {
            return;
        }

        requireSameOriginFormPost(request);

        loadManagerStateOrEmpty(settings);
        try {
            const result = await applyManagerState(
                () => {
                    const state = loadManagerStateOrEmpty(settings);
                    const current = buildManagerDiff(state, settings);
                    if (
                        readFormField(request.body, 'publicationRevision') !==
                        current.publicationRevision
                    ) {
                        throw createStatusError(
                            409,
                            'The publication preview changed. Review all pending changes again before publishing.',
                        );
                    }
                    return state;
                },
                settings,
                {
                    actor: createRequestAuditActor(request),
                    fetchImplementation: options.fetchImplementation,
                    now: options.now,
                },
            );

            const noticeText = result.reloadResult?.reloaded
                ? 'Applied runtime config and reloaded the server.'
                : 'Applied runtime config without requesting a server reload.';
            reply.redirect(
                buildUiNoticePath('/diff', {
                    kind: 'success',
                    text: noticeText,
                }),
                303,
            );
        } catch (error) {
            const message = error instanceof Error ? error.message : String(error);
            const failure = classifyApplyFailure(message);
            renderDiffPage(
                reply,
                settings,
                {
                    kind: failure.kind,
                    text: message,
                },
                getErrorStatusCode(error, failure.statusCode),
            );
        }
    });

    app.post('/reconcile/import', async (request: FastifyRequest, reply): Promise<void> => {
        if (!(await requireUiSession(request, reply, settings))) {
            return;
        }

        requireSameOriginFormPost(request);

        const snapshotJson = readFormField(request.body, 'snapshotJson') ?? '';

        try {
            const state = loadManagerStateOrEmpty(settings);
            const snapshot = parsePortableManagerStateSnapshotJson(snapshotJson, 'UI import form');
            const preview = previewPortableManagerStateImport(state, settings, snapshot);
            persistAuditedMutation(options, request, preview.state, {
                changedSiteIds: preview.changedSiteIds,
                kind: 'state-imported',
                message: 'Imported portable manager state and reset apply metadata.',
            });
            reply.redirect(
                buildUiNoticePath('/reconcile', {
                    kind: 'success',
                    text: 'Imported portable manager state and reset apply metadata.',
                }),
                303,
            );
        } catch (error) {
            const routeError = mapRouteError(error);
            renderReconcilePage(
                reply,
                settings,
                {
                    kind: 'error',
                    text: routeError.message,
                },
                {
                    importStateJson: snapshotJson,
                    statusCode: getErrorStatusCode(routeError, 400),
                },
            );
        }
    });

    app.post(
        '/reconcile/:source',
        async (request: FastifyRequest<{ Params: { source: string } }>, reply): Promise<void> => {
            if (!(await requireUiSession(request, reply, settings))) {
                return;
            }

            requireSameOriginFormPost(request);

            try {
                const source = reconcileSourceSchema.parse(request.params.source);
                const state = loadManagerStateOrEmpty(settings);
                const preview = buildManagerReconcilePreview(state, settings, source);
                persistAuditedMutation(options, request, preview.state, {
                    changedSiteIds: preview.changedSiteIds,
                    kind: 'state-reconciled',
                    message: `Reconciled manager state from the ${source} config and reset apply metadata.`,
                });
                reply.redirect(
                    buildUiNoticePath('/reconcile', {
                        kind: 'success',
                        text: `Reconciled manager state from the ${source} config and reset apply metadata.`,
                    }),
                    303,
                );
            } catch (error) {
                const routeError = mapRouteError(error);
                renderReconcilePage(
                    reply,
                    settings,
                    {
                        kind: 'error',
                        text: routeError.message,
                    },
                    {
                        statusCode: getErrorStatusCode(routeError, 400),
                    },
                );
            }
        },
    );

    app.get(
        '/audit',
        async (
            request: FastifyRequest<{ Querystring: { kind?: string; notice?: string } }>,
            reply,
        ): Promise<void> => {
            if (!(await requireUiSession(request, reply, settings))) {
                return;
            }

            try {
                const state = loadManagerStateOrEmpty(settings);
                const diff = buildManagerDiff(state, settings);
                reply.type('text/html; charset=utf-8').send(
                    renderManagerAuditPage({
                        driftStatus: diff.driftStatus,
                        events: listManagerAuditEvents(settings, { limit: 20 }),
                        notice: getUiNotice(request.query),
                        signOutPath: buildUiSignOutPath(settings),
                    }),
                );
            } catch (error) {
                const message = error instanceof Error ? error.message : String(error);
                renderUiFailure(reply, 500, 'Failed to load the audit view.', message);
            }
        },
    );
}
