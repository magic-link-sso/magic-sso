/**
 * manager/src/auth.ts
 *
 * Magic Link SSO Copyright (C) 2026 Wojciech Polak
 *
 * This program is free software; you can redistribute it and/or modify it
 * under the terms of the GNU General Public License as published by the
 * Free Software Foundation; either version 3 of the License, or (at your
 * option) any later version.
 *
 * This program is distributed in the hope that it will be useful,
 * but WITHOUT ANY WARRANTY; without even the implied warranty of
 * MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE. See the
 * GNU General Public License for more details.
 *
 * You should have received a copy of the GNU General Public License along
 * with this program. If not, see <https://www.gnu.org/licenses/>.
 */

import { FULL_ACCESS_SCOPE } from '@magic-link-sso/config-core';
import { timingSafeEqual } from 'node:crypto';
import { type IncomingHttpHeaders } from 'node:http';
import {
    type ManagerBearerTokenAuthConfig,
    type ManagerGateHeaderAuthConfig,
    type ManagerRuntimeSettings,
    type ManagerServiceAuthConfig,
} from './settings.js';

export interface ManagerApiActor {
    authType: 'internal-bearer-token';
}

export interface ManagerGateActor {
    authType: 'gate-forwarded-user';
    email: string;
    scope: string;
    siteId: string;
}

export type ManagerAuthenticatedActor = ManagerApiActor | ManagerGateActor;

function safeCompare(left: string, right: string): boolean {
    const leftBytes = new TextEncoder().encode(left);
    const rightBytes = new TextEncoder().encode(right);
    if (leftBytes.length !== rightBytes.length) {
        return false;
    }

    return timingSafeEqual(leftBytes, rightBytes);
}

function readSingleHeaderValue(value: string | string[] | undefined): string | undefined {
    if (Array.isArray(value)) {
        return value[0];
    }

    return typeof value === 'string' && value.length > 0 ? value : undefined;
}

function createAuthError(statusCode: number, message: string): Error {
    const error = new Error(message);
    Reflect.set(error, 'statusCode', statusCode);
    return error;
}

export function isGateHeaderAuthConfig(
    auth: ManagerServiceAuthConfig | undefined,
): auth is ManagerGateHeaderAuthConfig {
    return auth?.mode === 'gate';
}

export function isBearerTokenAuthConfig(
    auth: ManagerServiceAuthConfig | undefined,
): auth is ManagerBearerTokenAuthConfig {
    return (
        typeof auth === 'object' &&
        auth !== null &&
        typeof Reflect.get(auth, 'bearerToken') === 'string'
    );
}

export function extractBearerToken(authorizationHeader: string | undefined): string | undefined {
    if (typeof authorizationHeader !== 'string') {
        return undefined;
    }

    const [scheme, token] = authorizationHeader.trim().split(/\s+/u, 2);
    if (scheme !== 'Bearer' || typeof token !== 'string' || token.length === 0) {
        return undefined;
    }

    return token;
}

export function authenticateApiRequest(
    settings: ManagerRuntimeSettings,
    authorizationHeader: string | undefined,
): ManagerApiActor {
    const auth = settings.service?.auth;
    if (!isBearerTokenAuthConfig(auth)) {
        throw new Error(
            'Manager service auth is not configured. Add [service.auth] to MAGICSSO_MANAGER_CONFIG_FILE.',
        );
    }

    const submittedToken = extractBearerToken(authorizationHeader);
    if (typeof submittedToken !== 'string') {
        throw createAuthError(401, 'Missing or invalid Authorization header.');
    }

    if (!safeCompare(submittedToken, auth.bearerToken)) {
        throw createAuthError(403, 'Forbidden');
    }

    return {
        authType: 'internal-bearer-token',
    };
}

export function authenticateGateRequest(
    settings: ManagerRuntimeSettings,
    headers: IncomingHttpHeaders,
): ManagerGateActor {
    const auth = settings.service?.auth;
    if (!isGateHeaderAuthConfig(auth)) {
        throw new Error(
            'Manager Gate auth is not configured. Add gate mode to [service.auth] in MAGICSSO_MANAGER_CONFIG_FILE.',
        );
    }

    const email = readSingleHeaderValue(headers['x-magic-sso-user-email']);
    const scope = readSingleHeaderValue(headers['x-magic-sso-user-scope']);
    const siteId = readSingleHeaderValue(headers['x-magic-sso-site-id']);

    if (typeof email !== 'string' || typeof scope !== 'string' || typeof siteId !== 'string') {
        throw createAuthError(401, 'Missing or invalid Gate identity headers.');
    }

    if (siteId !== auth.requiredSiteId) {
        throw createAuthError(403, 'Forbidden');
    }

    if (scope !== FULL_ACCESS_SCOPE && scope !== auth.requiredScope) {
        throw createAuthError(403, 'Forbidden');
    }

    return {
        authType: 'gate-forwarded-user',
        email,
        scope,
        siteId,
    };
}

export function authenticateManagerRequest(
    settings: ManagerRuntimeSettings,
    headers: IncomingHttpHeaders,
): ManagerAuthenticatedActor {
    return isGateHeaderAuthConfig(settings.service?.auth)
        ? authenticateGateRequest(settings, headers)
        : authenticateApiRequest(settings, readSingleHeaderValue(headers.authorization));
}
