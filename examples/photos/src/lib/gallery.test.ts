// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Wojciech Polak

import { describe, expect, it } from 'vitest';
import { getAlbum, getAlbumCover, getPhoto, getPhotosForAlbum } from './gallery';

describe('gallery catalog', () => {
    it('resolves the mixed-access studio album', () => {
        const album = getAlbum('studio-notes');
        expect(album?.title).toBe('Studio Notes');
        expect(album?.photoSlugs).toContain('red-kite-at-dusk');
    });

    it('returns the cover photo for an album', () => {
        const album = getAlbum('city-postcards');
        if (typeof album === 'undefined') {
            throw new Error('Expected city-postcards album to exist.');
        }

        expect(getAlbumCover(album).slug).toBe('market-rain');
    });

    it('lists photos for a specific album', () => {
        expect(getPhotosForAlbum('studio-notes').map((photo) => photo.slug)).toEqual([
            'paper-moons',
            'red-kite-at-dusk',
        ]);
    });

    it('keeps the photo-specific scope attached to the locked demo photo', () => {
        expect(getPhoto('red-kite-at-dusk')?.access.scope).toBe('photo:red-kite-at-dusk');
    });
});
