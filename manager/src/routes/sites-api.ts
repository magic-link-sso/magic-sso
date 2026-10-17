// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 Wojciech Polak

import { z } from 'zod';
import type { ManagerAuditEventKind } from '../apply.js';
import {
    addSiteScope,
    getManagedSiteDetails,
    listManagedSites,
    loadManagerStateOrEmpty,
    persistManagerState,
    removeSiteScope,
    replaceSiteGrants,
    replaceSiteScopes,
    revokeSiteGrant,
    updateSiteGrant,
} from '../service.js';
import { createStatusError, mapRouteError } from '../http/errors.js';
import { assertApiEditingAllowed, persistAuditedMutation } from '../http/mutations.js';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import type { ManagerRouteContext } from '../http/context.js';

export function registerManagerSiteApiRoutes(
    app: FastifyInstance,
    options: ManagerRouteContext,
): void {
    const { settings } = options;
    const grantInputSchema = z
        .object({
            email: z
                .string()
                .trim()
                .email()
                .transform((value) => value.toLowerCase()),
            fullAccess: z.boolean().optional(),
            scopes: z.array(z.string().trim().min(1)).optional(),
        })
        .strict();

    const grantPatchSchema = z
        .object({
            fullAccess: z.boolean().optional(),
            scopes: z.array(z.string().trim().min(1)).optional(),
        })
        .strict();

    const accessReplaceSchema = z
        .object({
            grants: z.array(grantInputSchema),
        })
        .strict();

    const scopesReplaceSchema = z
        .object({
            scopes: z.array(z.string().trim().min(1)),
        })
        .strict();

    const addScopeSchema = z
        .object({
            scope: z.string().trim().min(1),
        })
        .strict();

    function parseScopes(
        fullAccess: boolean | undefined,
        scopes: readonly string[] | undefined,
    ): string[] {
        if (fullAccess === true) {
            if ((scopes?.length ?? 0) > 0) {
                throw createStatusError(
                    400,
                    'Use either "fullAccess": true or a non-empty "scopes" array, not both.',
                    'invalid_grant_payload',
                );
            }

            return ['*'];
        }

        if ((scopes?.length ?? 0) === 0) {
            throw createStatusError(
                400,
                'Write grant requests require "fullAccess": true or a non-empty "scopes" array.',
                'invalid_grant_payload',
            );
        }

        return [...scopes!];
    }

    /**
     * Run one audited single-site mutation and answer with the site's refreshed
     * details. `mutate` performs the request-specific parsing, permission check
     * and state change, so every route keeps the same ordering, audit trail and
     * error mapping.
     */
    function respondWithSiteMutation(
        request: FastifyRequest,
        siteId: string,
        mutate: () => {
            kind: Exclude<ManagerAuditEventKind, 'apply-failed' | 'apply-succeeded'>;
            message: string;
            nextState: Parameters<typeof persistManagerState>[1];
        },
    ): { site: ReturnType<typeof getManagedSiteDetails> } {
        try {
            const { kind, message, nextState } = mutate();
            const persistedState = persistAuditedMutation(options, request, nextState, {
                changedSiteIds: [siteId],
                kind,
                message,
            });
            return { site: getManagedSiteDetails(persistedState, settings, siteId) };
        } catch (error) {
            throw mapRouteError(error);
        }
    }

    app.get('/api/sites', async (): Promise<{ sites: ReturnType<typeof listManagedSites> }> => {
        const state = loadManagerStateOrEmpty(settings);
        return {
            sites: listManagedSites(state, settings),
        };
    });

    app.get(
        '/api/sites/:siteId',
        async (
            request: FastifyRequest<{ Params: { siteId: string } }>,
        ): Promise<{ site: ReturnType<typeof getManagedSiteDetails> }> => {
            try {
                const state = loadManagerStateOrEmpty(settings);
                return {
                    site: getManagedSiteDetails(state, settings, request.params.siteId),
                };
            } catch (error) {
                throw mapRouteError(error);
            }
        },
    );

    app.get(
        '/api/sites/:siteId/access',
        async (
            request: FastifyRequest<{ Params: { siteId: string } }>,
        ): Promise<{
            grants: ReturnType<typeof getManagedSiteDetails>['grants'];
            siteId: string;
        }> => {
            try {
                const state = loadManagerStateOrEmpty(settings);
                const site = getManagedSiteDetails(state, settings, request.params.siteId);
                return {
                    grants: site.grants,
                    siteId: site.id,
                };
            } catch (error) {
                throw mapRouteError(error);
            }
        },
    );

    app.get(
        '/api/sites/:siteId/scopes',
        async (
            request: FastifyRequest<{ Params: { siteId: string } }>,
        ): Promise<{
            scopes: ReturnType<typeof getManagedSiteDetails>['scopeCatalog'];
            siteId: string;
        }> => {
            try {
                const state = loadManagerStateOrEmpty(settings);
                const site = getManagedSiteDetails(state, settings, request.params.siteId);
                return {
                    scopes: site.scopeCatalog,
                    siteId: site.id,
                };
            } catch (error) {
                throw mapRouteError(error);
            }
        },
    );
    app.put(
        '/api/sites/:siteId/access',
        async (
            request: FastifyRequest<{
                Body: z.infer<typeof accessReplaceSchema>;
                Params: { siteId: string };
            }>,
        ): Promise<{ site: ReturnType<typeof getManagedSiteDetails> }> => {
            return respondWithSiteMutation(request, request.params.siteId, () => {
                const parsedBody = accessReplaceSchema.parse(request.body);
                assertApiEditingAllowed(settings);
                return {
                    kind: 'access-replaced',
                    message: `Replaced all grants on ${request.params.siteId}.`,
                    nextState: replaceSiteGrants(
                        loadManagerStateOrEmpty(settings),
                        settings,
                        request.params.siteId,
                        parsedBody.grants.map((grant) => ({
                            email: grant.email,
                            scopes: parseScopes(grant.fullAccess, grant.scopes),
                        })),
                    ),
                };
            });
        },
    );

    app.post(
        '/api/sites/:siteId/access/grants',
        async (
            request: FastifyRequest<{
                Body: z.infer<typeof grantInputSchema>;
                Params: { siteId: string };
            }>,
        ): Promise<{ site: ReturnType<typeof getManagedSiteDetails> }> => {
            return respondWithSiteMutation(request, request.params.siteId, () => {
                const parsedBody = grantInputSchema.parse(request.body);
                assertApiEditingAllowed(settings);
                return {
                    kind: 'grant-saved',
                    message: `Saved grant for ${parsedBody.email.trim().toLowerCase()} on ${request.params.siteId}.`,
                    nextState: updateSiteGrant(
                        loadManagerStateOrEmpty(settings),
                        settings,
                        request.params.siteId,
                        parsedBody.email,
                        parseScopes(parsedBody.fullAccess, parsedBody.scopes),
                    ),
                };
            });
        },
    );

    app.patch(
        '/api/sites/:siteId/access/grants/:email',
        async (
            request: FastifyRequest<{
                Body: z.infer<typeof grantPatchSchema>;
                Params: { email: string; siteId: string };
            }>,
        ): Promise<{ site: ReturnType<typeof getManagedSiteDetails> }> => {
            return respondWithSiteMutation(request, request.params.siteId, () => {
                const parsedBody = grantPatchSchema.parse(request.body);
                assertApiEditingAllowed(settings);
                return {
                    kind: 'grant-saved',
                    message: `Saved grant for ${request.params.email.trim().toLowerCase()} on ${request.params.siteId}.`,
                    nextState: updateSiteGrant(
                        loadManagerStateOrEmpty(settings),
                        settings,
                        request.params.siteId,
                        request.params.email,
                        parseScopes(parsedBody.fullAccess, parsedBody.scopes),
                    ),
                };
            });
        },
    );

    app.delete(
        '/api/sites/:siteId/access/grants/:email',
        async (
            request: FastifyRequest<{ Params: { email: string; siteId: string } }>,
        ): Promise<{ site: ReturnType<typeof getManagedSiteDetails> }> => {
            return respondWithSiteMutation(request, request.params.siteId, () => {
                assertApiEditingAllowed(settings);
                return {
                    kind: 'grant-revoked',
                    message: `Revoked grant for ${request.params.email.trim().toLowerCase()} on ${request.params.siteId}.`,
                    nextState: revokeSiteGrant(
                        loadManagerStateOrEmpty(settings),
                        settings,
                        request.params.siteId,
                        request.params.email,
                    ),
                };
            });
        },
    );

    app.put(
        '/api/sites/:siteId/scopes',
        async (
            request: FastifyRequest<{
                Body: z.infer<typeof scopesReplaceSchema>;
                Params: { siteId: string };
            }>,
        ): Promise<{ site: ReturnType<typeof getManagedSiteDetails> }> => {
            return respondWithSiteMutation(request, request.params.siteId, () => {
                const parsedBody = scopesReplaceSchema.parse(request.body);
                assertApiEditingAllowed(settings);
                return {
                    kind: 'scope-catalog-replaced',
                    message: `Replaced the scope catalog on ${request.params.siteId}.`,
                    nextState: replaceSiteScopes(
                        loadManagerStateOrEmpty(settings),
                        settings,
                        request.params.siteId,
                        parsedBody.scopes,
                    ),
                };
            });
        },
    );

    app.post(
        '/api/sites/:siteId/scopes',
        async (
            request: FastifyRequest<{
                Body: z.infer<typeof addScopeSchema>;
                Params: { siteId: string };
            }>,
        ): Promise<{ site: ReturnType<typeof getManagedSiteDetails> }> => {
            return respondWithSiteMutation(request, request.params.siteId, () => {
                const parsedBody = addScopeSchema.parse(request.body);
                assertApiEditingAllowed(settings);
                return {
                    kind: 'scope-added',
                    message: `Added scope ${parsedBody.scope.trim()} to ${request.params.siteId}.`,
                    nextState: addSiteScope(
                        loadManagerStateOrEmpty(settings),
                        settings,
                        request.params.siteId,
                        parsedBody.scope,
                    ),
                };
            });
        },
    );

    app.delete(
        '/api/sites/:siteId/scopes/:scope',
        async (
            request: FastifyRequest<{ Params: { scope: string; siteId: string } }>,
        ): Promise<{ site: ReturnType<typeof getManagedSiteDetails> }> => {
            return respondWithSiteMutation(request, request.params.siteId, () => {
                assertApiEditingAllowed(settings);
                return {
                    kind: 'scope-removed',
                    message: `Removed scope ${request.params.scope.trim()} from ${request.params.siteId}.`,
                    nextState: removeSiteScope(
                        loadManagerStateOrEmpty(settings),
                        settings,
                        request.params.siteId,
                        request.params.scope,
                    ),
                };
            });
        },
    );
}
