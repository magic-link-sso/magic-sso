/**
 * manager/src/app.ts
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

import rateLimit from '@fastify/rate-limit';
import Fastify, {
    type FastifyInstance,
    type FastifyReply,
    type FastifyRequest,
    type RouteOptions,
    type FastifyServerOptions,
} from 'fastify';
import { ZodError, z } from 'zod';
import {
    applyManagerState,
    reloadManagerRuntime,
    type ManagerAuditActor,
    type ManagerAuditEventKind,
    type ManagerReloadResult,
} from './apply.js';
import { recordManagerMutationAuditEvent } from './audit.js';
import {
    authenticateApiRequest,
    authenticateManagerRequest,
    isBearerTokenAuthConfig,
    isGateHeaderAuthConfig,
    type ManagerAuthenticatedActor,
} from './auth.js';
import {
    buildManagerDiff,
    buildManagerReconcilePreview,
    buildManagerReconcileStatus,
    exportPortableManagerStateSnapshot,
    getManagedSiteDetails,
    listManagedSites,
    listManagerAuditEvents,
    loadManagerStateOrEmpty,
    persistManagerState,
    previewPortableManagerStateImport,
    replaceSiteGrants,
    replaceSiteScopes,
    revokeSiteGrant,
    removeSiteScope,
    addSiteScope,
    updateSiteGrant,
} from './service.js';
import {
    parsePortableManagerStateSnapshotJson,
    stringifyPortableManagerStateSnapshot,
} from './state.js';
import {
    assertManagerAuditConfig,
    assertReloadSecretIsNotPlaceholder,
    loadManagerRuntimeSettings,
    type ManagerRuntimeSettings,
} from './settings.js';
import {
    renderManagerAuditPage,
    renderManagerDashboardPage,
    renderManagerDiffPage,
    renderManagerErrorPage,
    renderManagerLoginPage,
    renderManagerReconcilePage,
    renderManagerSitePage,
    type ManagerPageNotice,
    type ManagerSiteEditorDraft,
    type ManagerSitePageEditorState,
    type ManagerSiteScopeCatalogItem,
} from './ui.js';
import { detectConfigDrift } from './runtime.js';

export interface BuildAppOptions {
    fetchImplementation?: typeof fetch | undefined;
    logger?: FastifyServerOptions['logger'];
    now?: Date | undefined;
    settings?: ManagerRuntimeSettings | undefined;
}

export const MANAGER_SESSION_COOKIE_NAME = 'magic_sso_manager_session';
const MANAGER_SESSION_MAX_AGE_SECONDS = 8 * 60 * 60;
const MANAGER_LOGIN_RATE_LIMIT_MAX = 5;
const MANAGER_MUTATION_RATE_LIMIT_MAX = 30;
const MANAGER_RATE_LIMIT_WINDOW_MS = 60_000;
const MANAGER_HTML_CONTENT_SECURITY_POLICY =
    "default-src 'none'; style-src 'unsafe-inline'; script-src 'unsafe-inline'; form-action 'self'; frame-ancestors 'none'; base-uri 'none'";
const MANAGER_RATE_LIMIT_MESSAGE = 'Too many requests.';
const managerRequestActorKey = Symbol('managerRequestActor');

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

const stateImportSchema = z
    .object({
        state: z.unknown(),
    })
    .strict();

const reconcileSourceSchema = z.enum(['base', 'runtime']);

interface ApiErrorShape {
    code?: string | undefined;
    details?: unknown;
    statusCode: number;
}

interface StringRecord {
    [key: string]: string;
}

interface ManagerRouteRateLimitConfig {
    hook: 'preHandler';
    max: number;
    timeWindow: number;
}

function createStatusError(
    statusCode: number,
    message: string,
    code?: string | undefined,
    details?: unknown,
): Error & ApiErrorShape {
    const error = new Error(message) as Error & ApiErrorShape;
    error.statusCode = statusCode;
    error.code = code;
    error.details = details;
    return error;
}

function getStandardErrorMessage(error: Error, statusCode: number): string {
    return statusCode === 429 ? MANAGER_RATE_LIMIT_MESSAGE : error.message;
}

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

function isStringRecord(value: unknown): value is StringRecord {
    return (
        typeof value === 'object' &&
        value !== null &&
        Object.values(value).every((entry) => typeof entry === 'string')
    );
}

function readFormField(body: unknown, fieldName: string): string | undefined {
    if (!isStringRecord(body)) {
        return undefined;
    }

    const value = body[fieldName];
    return typeof value === 'string' ? value : undefined;
}

function collectSelectedScopes(body: unknown): string[] {
    if (!isStringRecord(body)) {
        return [];
    }

    return Object.entries(body)
        .filter(([key, value]) => key.startsWith('selectedScope') && value.trim().length > 0)
        .map(([, value]) => value);
}

function normalizeReturnToPath(value: string | undefined): string {
    if (typeof value !== 'string') {
        return '/';
    }

    const normalizedValue = value.trim();
    if (!normalizedValue.startsWith('/') || normalizedValue.startsWith('//')) {
        return '/';
    }

    return normalizedValue;
}

function readCookieValue(cookieHeader: string | undefined, cookieName: string): string | undefined {
    if (typeof cookieHeader !== 'string' || cookieHeader.length === 0) {
        return undefined;
    }

    const prefix = `${cookieName}=`;
    for (const item of cookieHeader.split(';')) {
        const trimmedItem = item.trim();
        if (!trimmedItem.startsWith(prefix)) {
            continue;
        }

        const value = trimmedItem.slice(prefix.length);
        try {
            return decodeURIComponent(value);
        } catch {
            return value;
        }
    }

    return undefined;
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

function buildSessionCookie(request: FastifyRequest, value: string, expires: boolean): string {
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

function requireSameOriginFormPost(request: FastifyRequest): void {
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

function authenticateUiRequest(
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

async function requireUiSession(
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

function getUiNotice(query: Record<string, string | undefined>): ManagerPageNotice | undefined {
    const kind = query.kind;
    const text = query.notice;
    if (typeof text !== 'string' || text.trim().length === 0) {
        return undefined;
    }

    if (kind === 'error' || kind === 'success' || kind === 'warning') {
        return {
            kind,
            text,
        };
    }

    return undefined;
}

function buildUiNoticePath(path: string, notice: ManagerPageNotice | undefined): string {
    if (typeof notice === 'undefined') {
        return path;
    }

    const searchParams = new URLSearchParams({
        kind: notice.kind,
        notice: notice.text,
    });
    return `${path}?${searchParams.toString()}`;
}

function buildUiSignOutPath(settings: ManagerRuntimeSettings): string {
    return isBearerTokenAuthConfig(settings.service?.auth) ? '/logout' : '/_magicgate/logout';
}

function buildGrantScopesFromForm(body: unknown): string[] {
    const grantMode = readFormField(body, 'grantMode');
    if (grantMode === 'full-access') {
        return ['*'];
    }

    const selectedScopes = collectSelectedScopes(body);
    if (selectedScopes.length === 0) {
        throw new Error('Limited access requires at least one selected permission.');
    }

    return selectedScopes;
}

function buildGrantDraftFromForm(body: unknown): ManagerSiteEditorDraft {
    const grantMode = readFormField(body, 'grantMode');
    return {
        email: readFormField(body, 'grantEmail')?.trim().toLowerCase() ?? '',
        scopes: grantMode === 'full-access' ? ['*'] : collectSelectedScopes(body),
    };
}

function buildSiteEditorStateForGrantSubmission(
    settings: ManagerRuntimeSettings,
    siteId: string,
    body: unknown,
): ManagerSitePageEditorState {
    const draft = buildGrantDraftFromForm(body);
    if (draft.email.length === 0) {
        return {
            addPersonDraft: draft,
            addPersonOpen: true,
        };
    }

    try {
        const site = getManagedSiteDetails(loadManagerStateOrEmpty(settings), settings, siteId);
        if (site.grants.some((grant) => grant.email === draft.email)) {
            return {
                expandedGrantDraft: draft,
                expandedGrantEmail: draft.email,
            };
        }
    } catch {
        return {
            addPersonDraft: draft,
            addPersonOpen: true,
        };
    }

    return {
        addPersonDraft: draft,
        addPersonOpen: true,
    };
}

function buildSiteScopeCatalog(
    site: ReturnType<typeof getManagedSiteDetails>,
): ManagerSiteScopeCatalogItem[] {
    return site.scopeCatalog.map((scope) => ({
        inUseCount: site.grants.filter((grant) => grant.scopes.includes(scope)).length,
        name: scope,
    }));
}

function isUiEditingAllowed(
    driftStatus: ReturnType<typeof buildManagerDiff>['driftStatus'],
): boolean {
    return driftStatus?.baseConfigDrifted !== true;
}

function createUiDriftFreezeError(): Error & ApiErrorShape {
    return createStatusError(
        409,
        'Base config drift detected. UI write actions are frozen until magic-sso.base.toml is synced and applied again.',
        'base_config_drift',
    );
}

function createApiDriftFreezeError(): Error & ApiErrorShape {
    return createStatusError(
        409,
        'Base config drift detected. Manager access mutations are frozen until magic-sso.base.toml is synced and applied again.',
        'base_config_drift',
    );
}

function assertUiEditingAllowed(settings: ManagerRuntimeSettings): void {
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

function assertApiEditingAllowed(settings: ManagerRuntimeSettings): void {
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

function getErrorStatusCode(error: unknown, fallbackStatusCode: number): number {
    if ((typeof error !== 'object' && typeof error !== 'function') || error === null) {
        return fallbackStatusCode;
    }

    const statusCode = Reflect.get(error, 'statusCode');
    return typeof statusCode === 'number' ? statusCode : fallbackStatusCode;
}

function renderSitePage(
    reply: FastifyReply,
    settings: ManagerRuntimeSettings,
    siteId: string,
    notice: ManagerPageNotice | undefined,
    options: {
        editorState?: ManagerSitePageEditorState | undefined;
        statusCode?: number | undefined;
    } = {},
): void {
    const state = loadManagerStateOrEmpty(settings);
    const diff = buildManagerDiff(state, settings);
    const site = getManagedSiteDetails(state, settings, siteId);
    reply
        .code(options.statusCode ?? 200)
        .type('text/html; charset=utf-8')
        .send(
            renderManagerSitePage({
                canEdit: isUiEditingAllowed(diff.driftStatus),
                driftStatus: diff.driftStatus,
                editorState: options.editorState,
                lastAppliedAt: state.metadata.lastAppliedAt,
                notice,
                pendingSiteDiff: diff.summary.changedSites.find((entry) => entry.siteId === siteId),
                site,
                signOutPath: buildUiSignOutPath(settings),
                siteScopeCatalog: buildSiteScopeCatalog(site),
            }),
        );
}

function renderDiffPage(
    reply: FastifyReply,
    settings: ManagerRuntimeSettings,
    notice: ManagerPageNotice | undefined,
    statusCode = 200,
): void {
    const state = loadManagerStateOrEmpty(settings);
    const diff = buildManagerDiff(state, settings);
    reply
        .code(statusCode)
        .type('text/html; charset=utf-8')
        .send(
            renderManagerDiffPage({
                canApply: diff.summary.hasChanges && isUiEditingAllowed(diff.driftStatus),
                diff,
                lastAppliedAt: state.metadata.lastAppliedAt,
                notice,
                reloadConfigured: typeof settings.reload !== 'undefined',
                runtimeConfigFile: settings.paths.runtimeConfigFile,
                signOutPath: buildUiSignOutPath(settings),
            }),
        );
}

function renderReconcilePage(
    reply: FastifyReply,
    settings: ManagerRuntimeSettings,
    notice: ManagerPageNotice | undefined,
    options: {
        importStateJson?: string | undefined;
        statusCode?: number | undefined;
    } = {},
): void {
    const state = loadManagerStateOrEmpty(settings);
    const diff = buildManagerDiff(state, settings);
    reply
        .code(options.statusCode ?? 200)
        .type('text/html; charset=utf-8')
        .send(
            renderManagerReconcilePage({
                driftStatus: diff.driftStatus,
                exportStateJson: stringifyPortableManagerStateSnapshot(
                    exportPortableManagerStateSnapshot(state),
                ),
                importStateJson: options.importStateJson ?? '',
                lastAppliedAt: state.metadata.lastAppliedAt,
                notice,
                reconcileStatus: buildManagerReconcileStatus(state, settings),
                signOutPath: buildUiSignOutPath(settings),
            }),
        );
}

function renderUiFailure(
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

function createRequestAuditActor(request: FastifyRequest): ManagerAuditActor {
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

function mapRouteError(error: unknown): Error {
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

export async function buildApp(options: BuildAppOptions = {}): Promise<FastifyInstance> {
    const settings = options.settings ?? loadManagerRuntimeSettings();
    assertManagerAuditConfig(settings);
    assertReloadSecretIsNotPlaceholder(settings);
    if (typeof settings.service === 'undefined') {
        throw new Error(
            'Manager service settings are not configured. Add [service] to MAGICSSO_MANAGER_CONFIG_FILE.',
        );
    }

    const app = Fastify({
        logger: options.logger ?? true,
        trustProxy: settings.service.trustProxy ?? false,
    });

    app.addContentTypeParser(
        'application/x-www-form-urlencoded',
        { parseAs: 'string' },
        (_request, body, done) => {
            done(
                null,
                Object.fromEntries(new URLSearchParams(typeof body === 'string' ? body : '')),
            );
        },
    );
    app.addHook('onRoute', (routeOptions) => {
        const rateLimitConfig = getManagerRouteRateLimitConfig(routeOptions);
        if (typeof rateLimitConfig === 'undefined') {
            return;
        }

        routeOptions.config = {
            ...(routeOptions.config ?? {}),
            rateLimit: rateLimitConfig,
        };
    });
    await app.register(rateLimit, {
        global: false,
    });

    app.addHook('onSend', async (_request, reply, payload) => {
        if (hasHtmlContentType(reply.getHeader('content-type'))) {
            reply.header('content-security-policy', MANAGER_HTML_CONTENT_SECURITY_POLICY);
        }

        return payload;
    });

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

    app.get('/healthz', async (): Promise<{ managedSiteCount: number; status: 'ok' }> => {
        return {
            managedSiteCount: settings.managedSiteIds.length,
            status: 'ok',
        };
    });

    function persistAuditedMutation(
        request: FastifyRequest,
        nextState: Parameters<typeof persistManagerState>[1],
        mutation: {
            changedSiteIds: string[];
            kind: Exclude<ManagerAuditEventKind, 'apply-failed' | 'apply-succeeded'>;
            message: string;
        },
    ): ReturnType<typeof persistManagerState> {
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

    if (isBearerTokenAuthConfig(settings.service.auth)) {
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
                persistAuditedMutation(request, nextState, {
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
                const routeError = mapRouteError(error);
                const message = routeError.message;
                const statusCode = getErrorStatusCode(routeError, 400);
                try {
                    renderSitePage(
                        reply,
                        settings,
                        request.params.siteId,
                        {
                            kind: 'error',
                            text: message,
                        },
                        {
                            editorState: buildSiteEditorStateForGrantSubmission(
                                settings,
                                request.params.siteId,
                                request.body,
                            ),
                            statusCode,
                        },
                    );
                } catch {
                    renderUiFailure(reply, statusCode, message);
                }
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
                persistAuditedMutation(request, nextState, {
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
                const routeError = mapRouteError(error);
                const message = routeError.message;
                const statusCode = getErrorStatusCode(routeError, 400);
                try {
                    renderSitePage(
                        reply,
                        settings,
                        request.params.siteId,
                        {
                            kind: 'error',
                            text: message,
                        },
                        {
                            statusCode,
                        },
                    );
                } catch {
                    renderUiFailure(reply, statusCode, message);
                }
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
                persistAuditedMutation(request, nextState, {
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
                const routeError = mapRouteError(error);
                const message = routeError.message;
                const statusCode = getErrorStatusCode(routeError, 400);
                try {
                    renderSitePage(
                        reply,
                        settings,
                        request.params.siteId,
                        {
                            kind: 'error',
                            text: message,
                        },
                        {
                            statusCode,
                        },
                    );
                } catch {
                    renderUiFailure(reply, statusCode, message);
                }
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
                persistAuditedMutation(request, nextState, {
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
                const routeError = mapRouteError(error);
                const message = routeError.message;
                const statusCode = getErrorStatusCode(routeError, 400);
                try {
                    renderSitePage(
                        reply,
                        settings,
                        request.params.siteId,
                        {
                            kind: 'error',
                            text: message,
                        },
                        {
                            statusCode,
                        },
                    );
                } catch {
                    renderUiFailure(reply, statusCode, message);
                }
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

        const state = loadManagerStateOrEmpty(settings);
        try {
            const result = await applyManagerState(state, settings, {
                actor: createRequestAuditActor(request),
                fetchImplementation: options.fetchImplementation,
                now: options.now,
            });

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

            if (
                message ===
                'Base config drift detected. Reconcile magic-sso.base.toml before running apply again.'
            ) {
                renderDiffPage(
                    reply,
                    settings,
                    {
                        kind: 'warning',
                        text: message,
                    },
                    409,
                );
                return;
            }

            if (message.startsWith('Another manager apply is already in progress:')) {
                renderDiffPage(
                    reply,
                    settings,
                    {
                        kind: 'error',
                        text: message,
                    },
                    409,
                );
                return;
            }

            if (
                message.startsWith('Failed to reach the server reload endpoint:') ||
                message.startsWith('Server reload failed:')
            ) {
                renderDiffPage(
                    reply,
                    settings,
                    {
                        kind: 'error',
                        text: message,
                    },
                    502,
                );
                return;
            }

            renderDiffPage(
                reply,
                settings,
                {
                    kind: 'error',
                    text: message,
                },
                400,
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
            persistAuditedMutation(request, preview.state, {
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
                persistAuditedMutation(request, preview.state, {
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

    app.addHook('onRequest', async (request: FastifyRequest): Promise<void> => {
        if (!request.url.startsWith('/api/')) {
            return;
        }

        setRequestAuthActor(request, authenticateManagerRequest(settings, request.headers));
        requireSameOriginApiMutation(settings, request);
    });

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
                const persistedState = persistAuditedMutation(request, preview.state, {
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
                const persistedState = persistAuditedMutation(request, preview.state, {
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

    app.put(
        '/api/sites/:siteId/access',
        async (
            request: FastifyRequest<{
                Body: z.infer<typeof accessReplaceSchema>;
                Params: { siteId: string };
            }>,
        ): Promise<{ site: ReturnType<typeof getManagedSiteDetails> }> => {
            try {
                const parsedBody = accessReplaceSchema.parse(request.body);
                assertApiEditingAllowed(settings);
                const state = loadManagerStateOrEmpty(settings);
                const nextState = replaceSiteGrants(
                    state,
                    settings,
                    request.params.siteId,
                    parsedBody.grants.map((grant) => ({
                        email: grant.email,
                        scopes: parseScopes(grant.fullAccess, grant.scopes),
                    })),
                );
                const persistedState = persistAuditedMutation(request, nextState, {
                    changedSiteIds: [request.params.siteId],
                    kind: 'access-replaced',
                    message: `Replaced all grants on ${request.params.siteId}.`,
                });
                return {
                    site: getManagedSiteDetails(persistedState, settings, request.params.siteId),
                };
            } catch (error) {
                throw mapRouteError(error);
            }
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
            try {
                const parsedBody = grantInputSchema.parse(request.body);
                assertApiEditingAllowed(settings);
                const state = loadManagerStateOrEmpty(settings);
                const nextState = updateSiteGrant(
                    state,
                    settings,
                    request.params.siteId,
                    parsedBody.email,
                    parseScopes(parsedBody.fullAccess, parsedBody.scopes),
                );
                const persistedState = persistAuditedMutation(request, nextState, {
                    changedSiteIds: [request.params.siteId],
                    kind: 'grant-saved',
                    message: `Saved grant for ${parsedBody.email.trim().toLowerCase()} on ${request.params.siteId}.`,
                });
                return {
                    site: getManagedSiteDetails(persistedState, settings, request.params.siteId),
                };
            } catch (error) {
                throw mapRouteError(error);
            }
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
            try {
                const parsedBody = grantPatchSchema.parse(request.body);
                assertApiEditingAllowed(settings);
                const state = loadManagerStateOrEmpty(settings);
                const nextState = updateSiteGrant(
                    state,
                    settings,
                    request.params.siteId,
                    request.params.email,
                    parseScopes(parsedBody.fullAccess, parsedBody.scopes),
                );
                const persistedState = persistAuditedMutation(request, nextState, {
                    changedSiteIds: [request.params.siteId],
                    kind: 'grant-saved',
                    message: `Saved grant for ${request.params.email.trim().toLowerCase()} on ${request.params.siteId}.`,
                });
                return {
                    site: getManagedSiteDetails(persistedState, settings, request.params.siteId),
                };
            } catch (error) {
                throw mapRouteError(error);
            }
        },
    );

    app.delete(
        '/api/sites/:siteId/access/grants/:email',
        async (
            request: FastifyRequest<{ Params: { email: string; siteId: string } }>,
        ): Promise<{ site: ReturnType<typeof getManagedSiteDetails> }> => {
            try {
                assertApiEditingAllowed(settings);
                const state = loadManagerStateOrEmpty(settings);
                const nextState = revokeSiteGrant(
                    state,
                    settings,
                    request.params.siteId,
                    request.params.email,
                );
                const persistedState = persistAuditedMutation(request, nextState, {
                    changedSiteIds: [request.params.siteId],
                    kind: 'grant-revoked',
                    message: `Revoked grant for ${request.params.email.trim().toLowerCase()} on ${request.params.siteId}.`,
                });
                return {
                    site: getManagedSiteDetails(persistedState, settings, request.params.siteId),
                };
            } catch (error) {
                throw mapRouteError(error);
            }
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
            try {
                const parsedBody = scopesReplaceSchema.parse(request.body);
                assertApiEditingAllowed(settings);
                const state = loadManagerStateOrEmpty(settings);
                const nextState = replaceSiteScopes(
                    state,
                    settings,
                    request.params.siteId,
                    parsedBody.scopes,
                );
                const persistedState = persistAuditedMutation(request, nextState, {
                    changedSiteIds: [request.params.siteId],
                    kind: 'scope-catalog-replaced',
                    message: `Replaced the scope catalog on ${request.params.siteId}.`,
                });
                return {
                    site: getManagedSiteDetails(persistedState, settings, request.params.siteId),
                };
            } catch (error) {
                throw mapRouteError(error);
            }
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
            try {
                const parsedBody = addScopeSchema.parse(request.body);
                assertApiEditingAllowed(settings);
                const state = loadManagerStateOrEmpty(settings);
                const nextState = addSiteScope(
                    state,
                    settings,
                    request.params.siteId,
                    parsedBody.scope,
                );
                const persistedState = persistAuditedMutation(request, nextState, {
                    changedSiteIds: [request.params.siteId],
                    kind: 'scope-added',
                    message: `Added scope ${parsedBody.scope.trim()} to ${request.params.siteId}.`,
                });
                return {
                    site: getManagedSiteDetails(persistedState, settings, request.params.siteId),
                };
            } catch (error) {
                throw mapRouteError(error);
            }
        },
    );

    app.delete(
        '/api/sites/:siteId/scopes/:scope',
        async (
            request: FastifyRequest<{ Params: { scope: string; siteId: string } }>,
        ): Promise<{ site: ReturnType<typeof getManagedSiteDetails> }> => {
            try {
                assertApiEditingAllowed(settings);
                const state = loadManagerStateOrEmpty(settings);
                const nextState = removeSiteScope(
                    state,
                    settings,
                    request.params.siteId,
                    request.params.scope,
                );
                const persistedState = persistAuditedMutation(request, nextState, {
                    changedSiteIds: [request.params.siteId],
                    kind: 'scope-removed',
                    message: `Removed scope ${request.params.scope.trim()} from ${request.params.siteId}.`,
                });
                return {
                    site: getManagedSiteDetails(persistedState, settings, request.params.siteId),
                };
            } catch (error) {
                throw mapRouteError(error);
            }
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
                const result = await applyManagerState(state, settings, {
                    actor: createRequestAuditActor(request),
                    fetchImplementation: options.fetchImplementation,
                    now: options.now,
                });
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

                if (message.startsWith('Another manager apply is already in progress:')) {
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

    return app;
}
