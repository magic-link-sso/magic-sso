// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 Wojciech Polak

import {
    addSiteScope,
    loadManagerStateOrEmpty,
    removeSiteScope,
    revokeSiteGrant,
    updateSiteGrant,
} from '../service.js';
import { requireSameOriginFormPost, requireUiSession } from '../http/security.js';
import { renderUiFailure } from '../http/errors.js';
import { assertUiEditingAllowed, persistAuditedMutation } from '../http/mutations.js';
import {
    buildGrantScopesFromForm,
    buildSiteEditorStateForGrantSubmission,
    buildUiNoticePath,
    getUiNotice,
    readFormField,
    renderSitePage,
    renderSiteMutationFailure,
} from '../http/ui.js';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import type { ManagerRouteContext } from '../http/context.js';

export function registerManagerSiteUiRoutes(
    app: FastifyInstance,
    options: ManagerRouteContext,
): void {
    const { settings } = options;
    app.get(
        '/sites/:siteId',
        async (
            request: FastifyRequest<{
                Params: { siteId: string };
                Querystring: { kind?: string; notice?: string };
            }>,
            reply,
        ): Promise<void> => {
            if (!(await requireUiSession(request, reply, settings))) {
                return;
            }

            try {
                renderSitePage(reply, settings, request.params.siteId, getUiNotice(request.query));
            } catch (error) {
                const message = error instanceof Error ? error.message : String(error);
                const statusCode =
                    error instanceof Error &&
                    /^Managed site .+ is not available\.$/.test(error.message)
                        ? 404
                        : 500;
                renderUiFailure(reply, statusCode, message);
            }
        },
    );

    app.post(
        '/sites/:siteId/access/grants',
        async (request: FastifyRequest<{ Params: { siteId: string } }>, reply): Promise<void> => {
            if (!(await requireUiSession(request, reply, settings))) {
                return;
            }

            requireSameOriginFormPost(request);

            const grantEmail = readFormField(request.body, 'grantEmail');
            if (typeof grantEmail !== 'string' || grantEmail.trim().length === 0) {
                renderSitePage(
                    reply,
                    settings,
                    request.params.siteId,
                    {
                        kind: 'error',
                        text: 'Email is required.',
                    },
                    {
                        editorState: buildSiteEditorStateForGrantSubmission(
                            settings,
                            request.params.siteId,
                            request.body,
                        ),
                        statusCode: 400,
                    },
                );
                return;
            }

            try {
                assertUiEditingAllowed(settings);
                const state = loadManagerStateOrEmpty(settings);
                const nextState = updateSiteGrant(
                    state,
                    settings,
                    request.params.siteId,
                    grantEmail,
                    buildGrantScopesFromForm(request.body),
                );
                persistAuditedMutation(options, request, nextState, {
                    changedSiteIds: [request.params.siteId],
                    kind: 'grant-saved',
                    message: `Saved grant for ${grantEmail.trim().toLowerCase()} on ${request.params.siteId}.`,
                });
                reply.redirect(
                    buildUiNoticePath(`/sites/${encodeURIComponent(request.params.siteId)}`, {
                        kind: 'success',
                        text: `Saved access for ${grantEmail.trim().toLowerCase()}.`,
                    }),
                    303,
                );
            } catch (error) {
                renderSiteMutationFailure(
                    settings,
                    reply,
                    request.params.siteId,
                    error,
                    buildSiteEditorStateForGrantSubmission(
                        settings,
                        request.params.siteId,
                        request.body,
                    ),
                );
            }
        },
    );

    app.post(
        '/sites/:siteId/access/grants/:email/revoke',
        async (
            request: FastifyRequest<{ Params: { email: string; siteId: string } }>,
            reply,
        ): Promise<void> => {
            if (!(await requireUiSession(request, reply, settings))) {
                return;
            }

            requireSameOriginFormPost(request);

            try {
                assertUiEditingAllowed(settings);
                const state = loadManagerStateOrEmpty(settings);
                const nextState = revokeSiteGrant(
                    state,
                    settings,
                    request.params.siteId,
                    request.params.email,
                );
                persistAuditedMutation(options, request, nextState, {
                    changedSiteIds: [request.params.siteId],
                    kind: 'grant-revoked',
                    message: `Revoked grant for ${request.params.email.trim().toLowerCase()} on ${request.params.siteId}.`,
                });
                reply.redirect(
                    buildUiNoticePath(`/sites/${encodeURIComponent(request.params.siteId)}`, {
                        kind: 'success',
                        text: `Removed access for ${request.params.email.trim().toLowerCase()}.`,
                    }),
                    303,
                );
            } catch (error) {
                renderSiteMutationFailure(settings, reply, request.params.siteId, error);
            }
        },
    );

    app.post(
        '/sites/:siteId/scopes',
        async (request: FastifyRequest<{ Params: { siteId: string } }>, reply): Promise<void> => {
            if (!(await requireUiSession(request, reply, settings))) {
                return;
            }

            requireSameOriginFormPost(request);

            const scopeName = readFormField(request.body, 'scopeName');
            if (typeof scopeName !== 'string' || scopeName.trim().length === 0) {
                renderSitePage(
                    reply,
                    settings,
                    request.params.siteId,
                    {
                        kind: 'error',
                        text: 'Permission name is required.',
                    },
                    {
                        statusCode: 400,
                    },
                );
                return;
            }

            try {
                assertUiEditingAllowed(settings);
                const state = loadManagerStateOrEmpty(settings);
                const nextState = addSiteScope(state, settings, request.params.siteId, scopeName);
                persistAuditedMutation(options, request, nextState, {
                    changedSiteIds: [request.params.siteId],
                    kind: 'scope-added',
                    message: `Added scope ${scopeName.trim()} to ${request.params.siteId}.`,
                });
                reply.redirect(
                    buildUiNoticePath(`/sites/${encodeURIComponent(request.params.siteId)}`, {
                        kind: 'success',
                        text: `Added permission ${scopeName.trim()}.`,
                    }),
                    303,
                );
            } catch (error) {
                renderSiteMutationFailure(settings, reply, request.params.siteId, error);
            }
        },
    );

    app.post(
        '/sites/:siteId/scopes/:scope/remove',
        async (
            request: FastifyRequest<{ Params: { scope: string; siteId: string } }>,
            reply,
        ): Promise<void> => {
            if (!(await requireUiSession(request, reply, settings))) {
                return;
            }

            requireSameOriginFormPost(request);

            try {
                assertUiEditingAllowed(settings);
                const state = loadManagerStateOrEmpty(settings);
                const nextState = removeSiteScope(
                    state,
                    settings,
                    request.params.siteId,
                    request.params.scope,
                );
                persistAuditedMutation(options, request, nextState, {
                    changedSiteIds: [request.params.siteId],
                    kind: 'scope-removed',
                    message: `Removed scope ${request.params.scope.trim()} from ${request.params.siteId}.`,
                });
                reply.redirect(
                    buildUiNoticePath(`/sites/${encodeURIComponent(request.params.siteId)}`, {
                        kind: 'success',
                        text: `Removed permission ${request.params.scope.trim()}.`,
                    }),
                    303,
                );
            } catch (error) {
                renderSiteMutationFailure(settings, reply, request.params.siteId, error);
            }
        },
    );
}
