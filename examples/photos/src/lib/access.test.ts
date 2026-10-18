// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Wojciech Polak

import { afterEach, describe, expect, it, vi } from 'vitest';
import {
    buildLoginHref,
    getAccessState,
    getScopeDisplayName,
    hasAccess,
    type ViewerSession,
} from './access';
import type { AuthPayload } from '@magic-link-sso/nextjs';

const friendsRequirement = {
    label: 'Friends',
    scope: 'friends',
};

afterEach((): void => {
    vi.unstubAllEnvs();
});

const fullAccessViewer: AuthPayload = {
    aud: 'http://localhost:5001',
    email: 'owner@example.com',
    exp: 1,
    iat: 1,
    iss: 'http://localhost:3000',
    jti: 'viewer-session-id',
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
        vi.stubEnv('MAGICSSO_BROWSER_SSO_MODE', 'off');
        expect(
            buildLoginHref('/photos/red-kite-at-dusk', {
                label: 'Special access',
                scope: 'photo:red-kite-at-dusk',
            }),
        ).toBe('/login?returnUrl=%2Fphotos%2Fred-kite-at-dusk&scope=photo%3Ared-kite-at-dusk');
    });

    it.each(['auto', 'required'])(
        'enters shared sign-in from gallery links in %s mode',
        (mode): void => {
            vi.stubEnv('MAGICSSO_BROWSER_SSO_MODE', mode);
            const target = new URL(
                buildLoginHref(
                    '/albums/friends-campfire?q=a%2Bb&tag=one&tag=two',
                    friendsRequirement,
                ),
                'http://photos.localhost:46006',
            );
            expect(target.pathname).toBe('/sso/start');
            expect(target.searchParams.get('returnUrl')).toBe(
                '/albums/friends-campfire?q=a%2Bb&tag=one&tag=two',
            );
            expect(target.searchParams.get('scope')).toBe('friends');
            expect(buildLoginHref('/')).toBe('/sso/start?returnUrl=%2F');
        },
    );

    it('formats special scopes for the UI', () => {
        expect(getScopeDisplayName('photo:red-kite-at-dusk')).toBe(
            'Special access: Red Kite at Dusk',
        );
    });
});
