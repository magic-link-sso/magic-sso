// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Wojciech Polak

import { describe, expect, it } from 'vitest';
import { getDemoEmailsFromEnv, getDemoScopeForEmail } from './demo-emails';

describe('getDemoEmailsFromEnv', () => {
    it('returns configured demo emails when present', () => {
        expect(
            getDemoEmailsFromEnv({
                PHOTOS_FAMILY_EMAIL: 'family@example.com',
                PHOTOS_FRIEND_EMAIL: 'friend@example.com',
                PHOTOS_OWNER_EMAIL: 'owner@example.com',
            }),
        ).toEqual(['owner@example.com', 'friend@example.com', 'family@example.com']);
    });

    it('deduplicates configured demo emails', () => {
        expect(
            getDemoEmailsFromEnv({
                PHOTOS_FAMILY_EMAIL: 'shared@example.com',
                PHOTOS_FRIEND_EMAIL: 'friend@example.com',
                PHOTOS_OWNER_EMAIL: 'shared@example.com',
            }),
        ).toEqual(['shared@example.com', 'friend@example.com']);
    });

    it('falls back to the default demo emails when the env is empty', () => {
        expect(getDemoEmailsFromEnv({})).toEqual([
            'owner@example.com',
            'friend@example.com',
            'family@example.com',
        ]);
    });

    it('returns the matching demo scope for the seeded friend and family emails', () => {
        expect(
            getDemoScopeForEmail('friend@example.com', {
                PHOTOS_FAMILY_EMAIL: 'family@example.com',
                PHOTOS_FRIEND_EMAIL: 'friend@example.com',
                PHOTOS_OWNER_EMAIL: 'owner@example.com',
            }),
        ).toBe('friends');
        expect(
            getDemoScopeForEmail('family@example.com', {
                PHOTOS_FAMILY_EMAIL: 'family@example.com',
                PHOTOS_FRIEND_EMAIL: 'friend@example.com',
                PHOTOS_OWNER_EMAIL: 'owner@example.com',
            }),
        ).toBe('family');
    });

    it('does not infer a scoped login for the owner or unknown emails', () => {
        const env = {
            PHOTOS_FAMILY_EMAIL: 'family@example.com',
            PHOTOS_FRIEND_EMAIL: 'friend@example.com',
            PHOTOS_OWNER_EMAIL: 'owner@example.com',
        };

        expect(getDemoScopeForEmail('owner@example.com', env)).toBeUndefined();
        expect(getDemoScopeForEmail('someone@example.com', env)).toBeUndefined();
    });
});
