// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 Wojciech Polak

import rateLimit from '@fastify/rate-limit';
import { readCookieValue } from '@magic-link-sso/config-core/runtime';
import type { FastifyInstance, FastifyReply, FastifyRequest, RouteOptions } from 'fastify';
import type { ManagerAuditActor } from '../apply.js';
import {
    authenticateApiRequest,
    authenticateManagerRequest,
    isBearerTokenAuthConfig,
    isGateHeaderAuthConfig,
    type ManagerAuthenticatedActor,
} from '../auth.js';
import type { ManagerRuntimeSettings } from '../settings.js';
import { createStatusError, getErrorStatusCode, mapRouteError, renderUiFailure } from './errors.js';

export const MANAGER_SESSION_COOKIE_NAME = 'magic_sso_manager_session';

const MANAGER_SESSION_MAX_AGE_SECONDS = 8 * 60 * 60;

const MANAGER_LOGIN_RATE_LIMIT_MAX = 5;

const MANAGER_MUTATION_RATE_LIMIT_MAX = 30;

const MANAGER_RATE_LIMIT_WINDOW_MS = 60_000;

const MANAGER_HTML_CONTENT_SECURITY_POLICY =
    "default-src 'none'; style-src 'unsafe-inline'; script-src 'unsafe-inline'; form-action 'self'; frame-ancestors 'none'; base-uri 'none'";

const managerRequestActorKey = Symbol('managerRequestActor');

interface ManagerRouteRateLimitConfig {
    hook: 'preHandler';
    max: number;
    timeWindow: number;
}

export function normalizeReturnToPath(value: string | undefined): string {
    if (typeof value !== 'string') {
        return '/';
    }

    const normalizedValue = value.trim();
    if (!normalizedValue.startsWith('/') || normalizedValue.startsWith('//')) {
        return '/';
    }

    return normalizedValue;
}

function readHeaderFirstValue(value: string | string[] | undefined): string | undefined {
    if (Array.isArray(value)) {
        return value[0];
    }

    if (typeof value !== 'string') {
        return undefined;
    }

    return value.split(',', 1)[0]?.trim();
}

function getRequestOrigin(request: FastifyRequest): string | undefined {
    const protocol = request.protocol;
    const host =
        (typeof request.host === 'string' && request.host.length > 0 ? request.host : undefined) ??
        readHeaderFirstValue(request.headers.host);

    if (protocol.length === 0 || typeof host !== 'string' || host.length === 0) {
        return undefined;
    }

    return `${protocol}://${host}`;
}

export function buildSessionCookie(
    request: FastifyRequest,
    value: string,
    expires: boolean,
): string {
    const attributes = [
        `${MANAGER_SESSION_COOKIE_NAME}=${encodeURIComponent(value)}`,
        'Path=/',
        'HttpOnly',
        'SameSite=Lax',
    ];
    const requestOrigin = getRequestOrigin(request);
    if (typeof requestOrigin === 'string' && requestOrigin.startsWith('https://')) {
        attributes.push('Secure');
    }
    if (expires) {
        attributes.push('Max-Age=0', 'Expires=Thu, 01 Jan 1970 00:00:00 GMT');
    } else {
        attributes.push(`Max-Age=${MANAGER_SESSION_MAX_AGE_SECONDS}`);
    }

    return attributes.join('; ');
}

function hasHtmlContentType(value: unknown): boolean {
    if (Array.isArray(value)) {
        return value.some((entry) => hasHtmlContentType(entry));
    }

    return (
        typeof value === 'string' && value.split(';', 1)[0]?.trim().toLowerCase() === 'text/html'
    );
}

function getManagerRouteRateLimitConfig(
    routeOptions: Pick<RouteOptions, 'method' | 'url'>,
): ManagerRouteRateLimitConfig | undefined {
    const methods = Array.isArray(routeOptions.method)
        ? routeOptions.method
        : [routeOptions.method];
    if (routeOptions.url === '/login' && methods.includes('POST')) {
        return {
            hook: 'preHandler',
            max: MANAGER_LOGIN_RATE_LIMIT_MAX,
            timeWindow: MANAGER_RATE_LIMIT_WINDOW_MS,
        };
    }

    if (routeOptions.url === '/logout') {
        return undefined;
    }

    if (methods.some((method) => isUnsafeMutationMethod(method))) {
        return {
            hook: 'preHandler',
            max: MANAGER_MUTATION_RATE_LIMIT_MAX,
            timeWindow: MANAGER_RATE_LIMIT_WINDOW_MS,
        };
    }

    return undefined;
}

export function requireSameOriginFormPost(request: FastifyRequest): void {
    const submittedOrigin = readHeaderFirstValue(request.headers.origin);
    const expectedOrigin = getRequestOrigin(request);
    if (
        typeof submittedOrigin !== 'string' ||
        typeof expectedOrigin !== 'string' ||
        submittedOrigin !== expectedOrigin
    ) {
        throw createStatusError(
            403,
            'Manager form submissions require a same-origin browser request.',
            'invalid_form_origin',
        );
    }
}

function isUnsafeMutationMethod(method: string): boolean {
    return method === 'POST' || method === 'PUT' || method === 'PATCH' || method === 'DELETE';
}

function requireSameOriginApiMutation(
    settings: ManagerRuntimeSettings,
    request: FastifyRequest,
): void {
    if (
        !isGateHeaderAuthConfig(settings.service?.auth) ||
        !isUnsafeMutationMethod(request.method)
    ) {
        return;
    }

    const submittedOrigin = readHeaderFirstValue(request.headers.origin);
    const expectedOrigin = getRequestOrigin(request);
    if (
        typeof submittedOrigin !== 'string' ||
        typeof expectedOrigin !== 'string' ||
        submittedOrigin !== expectedOrigin
    ) {
        throw createStatusError(
            403,
            'Manager API mutations require a same-origin browser request.',
            'invalid_api_origin',
        );
    }
}

function isManagerAuthenticatedActor(value: unknown): value is ManagerAuthenticatedActor {
    if (typeof value !== 'object' || value === null) {
        return false;
    }

    const authType = Reflect.get(value, 'authType');
    return authType === 'internal-bearer-token' || authType === 'gate-forwarded-user';
}

function setRequestAuthActor(
    request: FastifyRequest,
    actor: ManagerAuthenticatedActor,
): ManagerAuthenticatedActor {
    Reflect.set(request, managerRequestActorKey, actor);
    return actor;
}

function getRequestAuthActor(request: FastifyRequest): ManagerAuthenticatedActor | undefined {
    const actor = Reflect.get(request, managerRequestActorKey);
    return isManagerAuthenticatedActor(actor) ? actor : undefined;
}

export function authenticateUiRequest(
    settings: ManagerRuntimeSettings,
    request: FastifyRequest,
): ManagerAuthenticatedActor | undefined {
    if (!isBearerTokenAuthConfig(settings.service?.auth)) {
        return setRequestAuthActor(request, authenticateManagerRequest(settings, request.headers));
    }

    const sessionToken = readCookieValue(request.headers.cookie, MANAGER_SESSION_COOKIE_NAME);
    if (typeof sessionToken !== 'string' || sessionToken.length === 0) {
        return undefined;
    }

    try {
        return setRequestAuthActor(
            request,
            authenticateApiRequest(settings, `Bearer ${sessionToken}`),
        );
    } catch {
        return undefined;
    }
}

export async function requireUiSession(
    request: FastifyRequest,
    reply: FastifyReply,
    settings: ManagerRuntimeSettings,
): Promise<ManagerAuthenticatedActor | undefined> {
    try {
        const actor = authenticateUiRequest(settings, request);
        if (typeof actor !== 'undefined') {
            return actor;
        }
    } catch (error) {
        const routeError = mapRouteError(error);
        renderUiFailure(reply, getErrorStatusCode(routeError, 403), routeError.message);
        return undefined;
    }

    if (!isBearerTokenAuthConfig(settings.service?.auth)) {
        renderUiFailure(reply, 401, 'Missing or invalid Gate identity headers.');
        return undefined;
    }

    reply.redirect(`/login?returnTo=${encodeURIComponent(request.url)}`, 303);
    return undefined;
}

export function buildUiSignOutPath(settings: ManagerRuntimeSettings): string {
    return isBearerTokenAuthConfig(settings.service?.auth) ? '/logout' : '/_magicgate/logout';
}

export function createRequestAuditActor(request: FastifyRequest): ManagerAuditActor {
    const actor = getRequestAuthActor(request);
    return {
        host: request.ip,
        siteId: actor?.authType === 'gate-forwarded-user' ? actor.siteId : undefined,
        user:
            actor?.authType === 'gate-forwarded-user'
                ? actor.email
                : request.url.startsWith('/api/')
                  ? 'internal-bearer-token'
                  : 'browser-session',
    };
}

export async function registerManagerHttpSecurity(
    app: FastifyInstance,
    settings: ManagerRuntimeSettings,
): Promise<void> {
    app.addHook('onRoute', (routeOptions) => {
        const rateLimitConfig = getManagerRouteRateLimitConfig(routeOptions);
        if (typeof rateLimitConfig !== 'undefined') {
            routeOptions.config = { ...(routeOptions.config ?? {}), rateLimit: rateLimitConfig };
        }
    });
    await app.register(rateLimit, { global: false });
    app.addHook('onSend', async (_request, reply, payload) => {
        if (hasHtmlContentType(reply.getHeader('content-type'))) {
            reply.header('content-security-policy', MANAGER_HTML_CONTENT_SECURITY_POLICY);
        }

        return payload;
    });
    app.addHook('onRequest', async (request: FastifyRequest): Promise<void> => {
        if (!request.url.startsWith('/api/')) {
            return;
        }

        setRequestAuthActor(request, authenticateManagerRequest(settings, request.headers));
        requireSameOriginApiMutation(settings, request);
    });
}
