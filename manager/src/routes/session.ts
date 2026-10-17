// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 Wojciech Polak

import { authenticateApiRequest, isBearerTokenAuthConfig } from '../auth.js';
import { renderManagerLoginPage } from '../ui.js';
import {
    authenticateUiRequest,
    buildSessionCookie,
    normalizeReturnToPath,
    requireSameOriginFormPost,
} from '../http/security.js';
import { getUiNotice, readFormField } from '../http/ui.js';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import type { ManagerRouteContext } from '../http/context.js';

export function registerManagerSessionRoutes(
    app: FastifyInstance,
    options: ManagerRouteContext,
): void {
    const { settings } = options;
    if (isBearerTokenAuthConfig(settings.service?.auth)) {
        app.get(
            '/login',
            async (
                request: FastifyRequest<{
                    Querystring: { kind?: string; notice?: string; returnTo?: string };
                }>,
                reply,
            ): Promise<void> => {
                if (typeof authenticateUiRequest(settings, request) !== 'undefined') {
                    reply.redirect(normalizeReturnToPath(request.query.returnTo), 303);
                    return;
                }

                reply.type('text/html; charset=utf-8').send(
                    renderManagerLoginPage({
                        notice: getUiNotice(request.query),
                        returnTo: normalizeReturnToPath(request.query.returnTo),
                    }),
                );
            },
        );

        app.post('/login', async (request, reply): Promise<void> => {
            requireSameOriginFormPost(request);

            const managerToken = readFormField(request.body, 'managerToken');
            const returnTo = normalizeReturnToPath(readFormField(request.body, 'returnTo'));

            try {
                authenticateApiRequest(settings, `Bearer ${managerToken ?? ''}`);
            } catch {
                reply
                    .code(403)
                    .type('text/html; charset=utf-8')
                    .send(
                        renderManagerLoginPage({
                            notice: {
                                kind: 'error',
                                text: 'The submitted manager token was rejected.',
                            },
                            returnTo,
                        }),
                    );
                return;
            }

            reply.header('set-cookie', buildSessionCookie(request, managerToken ?? '', false));
            reply.redirect(returnTo, 303);
        });

        app.post('/logout', async (request, reply): Promise<void> => {
            requireSameOriginFormPost(request);

            reply.header('set-cookie', buildSessionCookie(request, '', true));
            reply.redirect('/login', 303);
        });
    }
}
