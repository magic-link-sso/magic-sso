// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 Wojciech Polak

import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { z } from 'zod';
import {
    confirmPersonAccess,
    getPersonAccess,
    listPeople,
    previewPersonAccess,
    PersonPreviewConflictError,
    type PersonAccessChange,
} from '../people.js';
import { buildManagerDiff, loadManagerStateOrEmpty } from '../service.js';
import {
    renderManagerPeoplePage,
    renderManagerPersonPage,
    renderManagerPersonPreview,
    type PersonAccessEditorDraft,
} from '../ui.js';
import type { ManagerRouteContext } from '../http/context.js';
import {
    createStatusError,
    getErrorStatusCode,
    mapRouteError,
    renderUiFailure,
} from '../http/errors.js';
import {
    assertUiEditingAllowed,
    isUiEditingAllowed,
    persistAuditedMutation,
} from '../http/mutations.js';
import {
    buildUiSignOutPath,
    requireSameOriginFormPost,
    requireUiSession,
} from '../http/security.js';
import { buildUiNoticePath, getUiNotice, readFormField } from '../http/ui.js';

function readAccessDraft(body: unknown): PersonAccessEditorDraft[] {
    const fields = z.record(z.string(), z.string()).parse(body);
    return Object.entries(fields).flatMap(([key, siteId]) => {
        const match = /^site(\d+)$/u.exec(key);
        if (!match) {
            return [];
        }
        const index = match[1];
        const mode = fields[`mode${index}`];
        const scopes =
            mode === 'full'
                ? ['*']
                : mode === 'remove'
                  ? []
                  : Object.entries(fields)
                        .filter(([name]) => name.startsWith(`scope${index}_`))
                        .map(([, value]) => value);
        return [{ siteId, scopes, mode }];
    });
}

function changesFromDraft(draft: readonly PersonAccessEditorDraft[]): PersonAccessChange[] {
    return draft.flatMap(({ siteId, mode, scopes }) => {
        if (mode === 'unchanged') {
            return [];
        }
        if (!['remove', 'full', 'scoped'].includes(mode ?? '')) {
            throw new Error('Choose an access level for each application.');
        }
        if (mode === 'scoped' && scopes.length === 0) {
            throw new Error(`Select at least one permission for ${siteId}.`);
        }
        return [{ siteId, scopes }];
    });
}

type PersonRequest = FastifyRequest<{
    Params: { email: string };
    Querystring: { kind?: string; notice?: string };
}>;

export function registerManagerPeopleUiRoutes(
    app: FastifyInstance,
    options: ManagerRouteContext,
): void {
    const { settings } = options;
    const signOutPath = buildUiSignOutPath(settings);

    function renderPerson(
        request: PersonRequest,
        reply: FastifyReply,
        statusCode = 200,
        error?: unknown,
        draft?: PersonAccessEditorDraft[],
    ): void {
        const state = loadManagerStateOrEmpty(settings);
        const diff = buildManagerDiff(state, settings);
        reply
            .code(statusCode)
            .type('text/html; charset=utf-8')
            .send(
                renderManagerPersonPage({
                    person: getPersonAccess(state, settings, request.params.email),
                    canEdit: isUiEditingAllowed(diff.driftStatus),
                    driftStatus: diff.driftStatus,
                    signOutPath,
                    draft,
                    notice:
                        error === undefined
                            ? getUiNotice(request.query)
                            : { kind: 'error', text: mapRouteError(error).message },
                }),
            );
    }

    function renderPersonFailure(
        request: PersonRequest,
        reply: FastifyReply,
        error: unknown,
        draft?: PersonAccessEditorDraft[],
    ): void {
        const mapped =
            error instanceof PersonPreviewConflictError
                ? createStatusError(409, error.message)
                : mapRouteError(error);
        const status = getErrorStatusCode(mapped, 400);
        try {
            renderPerson(request, reply, status, mapped, draft);
        } catch {
            renderUiFailure(reply, status, mapped.message);
        }
    }

    app.get(
        '/people',
        async (
            request: FastifyRequest<{ Querystring: { email?: string } }>,
            reply,
        ): Promise<void> => {
            if (!(await requireUiSession(request, reply, settings))) {
                return;
            }
            if (request.query.email !== undefined) {
                const parsed = z
                    .string()
                    .trim()
                    .toLowerCase()
                    .email()
                    .safeParse(request.query.email);
                if (!parsed.success) {
                    renderUiFailure(reply, 400, 'Enter a valid email address.');
                    return;
                }
                const email = parsed.data;
                reply.redirect(`/people/${encodeURIComponent(email)}`, 303);
                return;
            }
            reply.type('text/html; charset=utf-8').send(
                renderManagerPeoplePage({
                    people: listPeople(loadManagerStateOrEmpty(settings), settings),
                    signOutPath,
                }),
            );
        },
    );

    app.get('/people/:email', async (request: PersonRequest, reply): Promise<void> => {
        if (!(await requireUiSession(request, reply, settings))) {
            return;
        }
        try {
            renderPerson(request, reply);
        } catch (error) {
            renderPersonFailure(request, reply, error);
        }
    });

    app.post('/people/:email/preview', async (request: PersonRequest, reply): Promise<void> => {
        if (!(await requireUiSession(request, reply, settings))) {
            return;
        }
        requireSameOriginFormPost(request);
        let draft: PersonAccessEditorDraft[] | undefined;
        try {
            assertUiEditingAllowed(settings);
            draft = readAccessDraft(request.body);
            const changes = changesFromDraft(draft);
            if (changes.length === 0) {
                throw new Error('Select an access change for at least one application.');
            }
            const state = loadManagerStateOrEmpty(settings);
            const preview = previewPersonAccess(
                state,
                settings,
                request.params.email,
                changes,
                options.now,
            );
            reply.type('text/html; charset=utf-8').send(
                renderManagerPersonPreview({
                    person: getPersonAccess(state, settings, preview.email),
                    preview,
                    signOutPath,
                }),
            );
        } catch (error) {
            renderPersonFailure(request, reply, error, draft);
        }
    });

    app.post('/people/:email/save', async (request: PersonRequest, reply): Promise<void> => {
        if (!(await requireUiSession(request, reply, settings))) {
            return;
        }
        requireSameOriginFormPost(request);
        try {
            assertUiEditingAllowed(settings);
            const state = loadManagerStateOrEmpty(settings);
            const preview = confirmPersonAccess(
                state,
                settings,
                readFormField(request.body, 'previewToken') ?? '',
                options.now,
            );
            if (preview.email !== request.params.email.trim().toLowerCase()) {
                throw createStatusError(
                    409,
                    'Preview belongs to another person. Review access again.',
                );
            }
            persistAuditedMutation(options, request, preview.nextState, {
                kind: 'access-replaced',
                changedSiteIds: preview.changes.map((change) => change.siteId),
                message: `Saved access for ${preview.email} across ${preview.changes.length} applications after preview.`,
            });
            reply.redirect(
                buildUiNoticePath(`/people/${encodeURIComponent(preview.email)}`, {
                    kind: 'success',
                    text: 'Saved pending changes. Review all pending changes before publishing.',
                }),
                303,
            );
        } catch (error) {
            renderPersonFailure(request, reply, error);
        }
    });
}
