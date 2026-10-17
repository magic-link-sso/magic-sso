// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 Wojciech Polak

import type { FastifyInstance, FastifyReply } from 'fastify';
import { ZodError } from 'zod';
import { renderManagerErrorPage } from '../ui.js';

interface ApiErrorShape {
    code?: string | undefined;
    details?: unknown;
    statusCode: number;
}

const MANAGER_RATE_LIMIT_MESSAGE = 'Too many requests.';

export function createStatusError(
    statusCode: number,
    message: string,
    code?: string | undefined,
    details?: unknown,
): Error & ApiErrorShape {
    return Object.assign(new Error(message), { statusCode, code, details });
}

function getStandardErrorMessage(error: Error, statusCode: number): string {
    return statusCode === 429 ? MANAGER_RATE_LIMIT_MESSAGE : error.message;
}

export function getErrorStatusCode(error: unknown, fallbackStatusCode: number): number {
    if ((typeof error !== 'object' && typeof error !== 'function') || error === null) {
        return fallbackStatusCode;
    }

    const statusCode = Reflect.get(error, 'statusCode');
    return typeof statusCode === 'number' ? statusCode : fallbackStatusCode;
}

export function renderUiFailure(
    reply: FastifyReply,
    statusCode: number,
    message: string,
    details?: string | undefined,
): void {
    reply.code(statusCode).type('text/html; charset=utf-8').send(
        renderManagerErrorPage({
            details,
            message,
            statusCode,
        }),
    );
}

export function mapRouteError(error: unknown): Error {
    if (error instanceof Error && typeof Reflect.get(error, 'statusCode') === 'number') {
        return error;
    }

    if (error instanceof ZodError) {
        return createStatusError(
            400,
            `Invalid request body: ${error.issues[0]?.message ?? error.message}`,
            'invalid_request_body',
        );
    }

    if (error instanceof Error && /^Managed site .+ is not available\.$/.test(error.message)) {
        return createStatusError(404, error.message, 'site_not_found');
    }

    if (error instanceof Error && /^Grant for .+ does not exist on .+\.$/.test(error.message)) {
        return createStatusError(404, error.message, 'grant_not_found');
    }

    if (error instanceof Error && /^Scope .+ does not exist on .+\.$/.test(error.message)) {
        return createStatusError(404, error.message, 'scope_not_found');
    }

    if (error instanceof Error && /^Scope .+ is still assigned on .+\.$/.test(error.message)) {
        return createStatusError(409, error.message, 'scope_in_use');
    }

    if (
        error instanceof Error &&
        /^Scope .+ is not in the catalog for .+\. Add it first with scopes add\.$/.test(
            error.message,
        )
    ) {
        return createStatusError(400, error.message, 'scope_not_in_catalog');
    }

    return error instanceof Error ? error : new Error(String(error));
}

export function registerManagerErrorHandler(app: FastifyInstance): void {
    app.setErrorHandler((error: Error, request, reply): void => {
        const statusCode = Reflect.get(error, 'statusCode');
        if (typeof statusCode === 'number' && statusCode >= 400 && statusCode < 500) {
            const message = getStandardErrorMessage(error, statusCode);
            if (!request.url.startsWith('/api/')) {
                renderUiFailure(reply, statusCode, message);
                return;
            }

            const responseBody: {
                code?: string | undefined;
                details?: unknown;
                message: string;
            } = {
                message,
            };
            const code = Reflect.get(error, 'code');
            if (typeof code === 'string') {
                responseBody.code = code;
            }
            if (Reflect.has(error, 'details')) {
                responseBody.details = Reflect.get(error, 'details');
            }
            reply.code(statusCode).send(responseBody);
            return;
        }

        if (!request.url.startsWith('/api/')) {
            renderUiFailure(reply, 500, 'Internal Server Error');
            return;
        }

        reply.code(500).send({
            message: 'Internal Server Error',
        });
    });
}
