// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 Wojciech Polak

import type { FastifyReply } from 'fastify';
import {
    buildManagerDiff,
    buildManagerReconcileStatus,
    exportPortableManagerStateSnapshot,
    getManagedSiteDetails,
    loadManagerStateOrEmpty,
} from '../service.js';
import { stringifyPortableManagerStateSnapshot } from '../state.js';
import type { ManagerRuntimeSettings } from '../settings.js';
import {
    renderManagerDiffPage,
    renderManagerReconcilePage,
    renderManagerSitePage,
    type ManagerPageNotice,
    type ManagerSiteEditorDraft,
    type ManagerSitePageEditorState,
    type ManagerSiteScopeCatalogItem,
} from '../ui.js';
import { buildUiSignOutPath } from './security.js';
import { isUiEditingAllowed } from './mutations.js';
import { getErrorStatusCode, mapRouteError, renderUiFailure } from './errors.js';

interface StringRecord {
    [key: string]: string;
}

function isStringRecord(value: unknown): value is StringRecord {
    return (
        typeof value === 'object' &&
        value !== null &&
        Object.values(value).every((entry) => typeof entry === 'string')
    );
}

export function readFormField(body: unknown, fieldName: string): string | undefined {
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

export function getUiNotice(
    query: Record<string, string | undefined>,
): ManagerPageNotice | undefined {
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

export function buildUiNoticePath(path: string, notice: ManagerPageNotice | undefined): string {
    if (typeof notice === 'undefined') {
        return path;
    }

    const searchParams = new URLSearchParams({
        kind: notice.kind,
        notice: notice.text,
    });
    return `${path}?${searchParams.toString()}`;
}

export function buildGrantScopesFromForm(body: unknown): string[] {
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

export function buildSiteEditorStateForGrantSubmission(
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

export function renderSitePage(
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

export function classifyApplyFailure(message: string): {
    kind: 'error' | 'warning';
    statusCode: number;
} {
    if (
        message ===
        'Base config drift detected. Reconcile magic-sso.base.toml before running apply again.'
    ) {
        return { kind: 'warning', statusCode: 409 };
    }

    if (message.startsWith('Another manager write is already in progress:')) {
        return { kind: 'error', statusCode: 409 };
    }

    const isReloadFailure =
        message.startsWith('Failed to reach the server reload endpoint:') ||
        message.startsWith('Server reload failed:');
    return { kind: 'error', statusCode: isReloadFailure ? 502 : 400 };
}

export function renderDiffPage(
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

export function renderReconcilePage(
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

/**
 * Re-render a site page carrying the failure notice for a rejected form post,
 * falling back to the plain failure page when the site page itself cannot be
 * rendered (for example when the site no longer exists).
 */
export function renderSiteMutationFailure(
    settings: ManagerRuntimeSettings,
    reply: FastifyReply,
    siteId: string,
    error: unknown,
    editorState?: ManagerSitePageEditorState,
): void {
    const routeError = mapRouteError(error);
    const message = routeError.message;
    const statusCode = getErrorStatusCode(routeError, 400);
    try {
        renderSitePage(
            reply,
            settings,
            siteId,
            { kind: 'error', text: message },
            { editorState, statusCode },
        );
    } catch {
        renderUiFailure(reply, statusCode, message);
    }
}
