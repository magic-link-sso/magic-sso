// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Wojciech Polak

import { describe, expect, it } from 'vitest';
import {
    buildLoginHref,
    getAccessState,
    getScopeDisplayName,
    hasAccess,
    type ViewerSession,
} from './access';

const friendsRequirement = {
    label: 'Friends',
    scope: 'friends',
};

const fullAccessViewer: ViewerSession = {
    aud: 'http://localhost:5001',
    email: 'owner@example.com',
    exp: 1,
    iat: 1,
    iss: 'http://localhost:3000',
    scope: '*',
    siteId: 'photos',
};

describe('access helpers', () => {
    it('always allows public resources', () => {
        expect(hasAccess(null, { label: 'Public' })).toBe(true);
    });

    it('allows wildcard sessions to open scoped resources', () => {
        expect(hasAccess(fullAccessViewer, friendsRequirement)).toBe(true);
    });

    it('returns switch-scope for signed-in viewers with the wrong scope', () => {
        const familyViewer: ViewerSession = {
            ...fullAccessViewer,
            email: 'family@example.com',
            scope: 'family',
        };

        expect(getAccessState(familyViewer, friendsRequirement)).toBe('switch-scope');
    });

    it('builds login targets that preserve the requested return path and scope', () => {
        expect(
            buildLoginHref('/photos/red-kite-at-dusk', {
                label: 'Special access',
                scope: 'photo:red-kite-at-dusk',
            }),
        ).toBe('/login?returnUrl=%2Fphotos%2Fred-kite-at-dusk&scope=photo%3Ared-kite-at-dusk');
    });

    it('formats special scopes for the UI', () => {
        expect(getScopeDisplayName('photo:red-kite-at-dusk')).toBe(
            'Special access: Red Kite at Dusk',
        );
    });
});
