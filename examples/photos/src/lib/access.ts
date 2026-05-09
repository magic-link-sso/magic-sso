// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Wojciech Polak

import type { AuthPayload } from '@magic-link-sso/nextjs';

export type ViewerSession = AuthPayload | null;

export interface AccessRequirement {
    readonly label: string;
    readonly scope?: string;
}

export type AccessState = 'authorized' | 'signin' | 'switch-scope';

export function hasAccess(viewer: ViewerSession, requirement: AccessRequirement): boolean {
    if (typeof requirement.scope !== 'string') {
        return true;
    }

    if (viewer === null) {
        return false;
    }

    return viewer.scope === '*' || viewer.scope === requirement.scope;
}

export function getAccessState(viewer: ViewerSession, requirement: AccessRequirement): AccessState {
    if (hasAccess(viewer, requirement)) {
        return 'authorized';
    }

    return viewer === null ? 'signin' : 'switch-scope';
}

export function buildLoginHref(returnPath: string, requirement: AccessRequirement): string {
    const loginUrl = new URL('/login', 'http://magic-link-sso.local');
    loginUrl.searchParams.set('returnUrl', returnPath);
    if (typeof requirement.scope === 'string') {
        loginUrl.searchParams.set('scope', requirement.scope);
    }

    return `${loginUrl.pathname}${loginUrl.search}`;
}

export function getScopeDisplayName(scope: string): string {
    switch (scope) {
        case '*':
            return 'Owner access';
        case 'friends':
            return 'Friends';
        case 'family':
            return 'Family';
        case 'photo:red-kite-at-dusk':
            return 'Special access: Red Kite at Dusk';
        default:
            return scope;
    }
}

export function getViewerScopeSummary(viewer: ViewerSession): string {
    if (viewer === null) {
        return 'Public visitor';
    }

    return getScopeDisplayName(viewer.scope);
}
