// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Wojciech Polak

import type { AccessRequirement } from './access';

export interface Photo {
    readonly access: AccessRequirement;
    readonly albumSlug: string;
    readonly alt: string;
    readonly artworkPath: string;
    readonly blurb: string;
    readonly caption: string;
    readonly slug: string;
    readonly title: string;
    readonly year: string;
}

export interface Album {
    readonly access: AccessRequirement;
    readonly blurb: string;
    readonly coverPhotoSlug: string;
    readonly description: string;
    readonly photoSlugs: readonly string[];
    readonly slug: string;
    readonly title: string;
}

const publicAccess: AccessRequirement = {
    label: 'Public',
};

const friendsAccess: AccessRequirement = {
    label: 'Friends',
    scope: 'friends',
};

const familyAccess: AccessRequirement = {
    label: 'Family',
    scope: 'family',
};

const redKiteAccess: AccessRequirement = {
    label: 'Special access',
    scope: 'photo:red-kite-at-dusk',
};

const photos: readonly Photo[] = [
    {
        access: publicAccess,
        albumSlug: 'city-postcards',
        alt: 'Abstract tram lines and neon lights in a rainy city street.',
        artworkPath: '/art/neon-tram.svg',
        blurb: 'Rain-slick reflections, tram cables, and one glowing station clock.',
        caption: 'Painted as a study in reflected light and quick movement.',
        slug: 'neon-tram',
        title: 'Neon Tram',
        year: '2026',
    },
    {
        access: publicAccess,
        albumSlug: 'city-postcards',
        alt: 'Geometric storefront awnings and warm lights in an evening market.',
        artworkPath: '/art/market-rain.svg',
        blurb: 'A market scene built from awnings, lanterns, and wet cobblestones.',
        caption: 'The public street-series album that anyone can browse.',
        slug: 'market-rain',
        title: 'Market Rain',
        year: '2026',
    },
    {
        access: friendsAccess,
        albumSlug: 'friends-campfire',
        alt: 'Stylized campfire figures framed by pines and a large moon.',
        artworkPath: '/art/campfire-choir.svg',
        blurb: 'Loose memories from late-night songs by the lake.',
        caption: 'Shared only with friends who were there for the first sketchbook run.',
        slug: 'campfire-choir',
        title: 'Campfire Choir',
        year: '2025',
    },
    {
        access: familyAccess,
        albumSlug: 'family-attic',
        alt: 'Abstract stars, keepsakes, and boxes arranged in an attic scene.',
        artworkPath: '/art/attic-orbit.svg',
        blurb: 'A memory map of keepsakes, tapes, and folded letters.',
        caption: 'Reserved for family because the notes around it reference private stories.',
        slug: 'attic-orbit',
        title: 'Attic Orbit',
        year: '2026',
    },
    {
        access: publicAccess,
        albumSlug: 'studio-notes',
        alt: 'Graphic moon phases and paper shapes over a deep blue field.',
        artworkPath: '/art/paper-moons.svg',
        blurb: 'One of the open sketches from the studio wall.',
        caption: 'Anyone can browse this page, including anonymous visitors.',
        slug: 'paper-moons',
        title: 'Paper Moons',
        year: '2026',
    },
    {
        access: redKiteAccess,
        albumSlug: 'studio-notes',
        alt: 'A red kite shape over dusk gradients and nested hill silhouettes.',
        artworkPath: '/art/red-kite-at-dusk.svg',
        blurb: 'A study that stays private until a dedicated photo scope is granted.',
        caption: 'This piece demonstrates a photo-specific scope inside a mostly public album.',
        slug: 'red-kite-at-dusk',
        title: 'Red Kite at Dusk',
        year: '2026',
    },
];

const albums: readonly Album[] = [
    {
        access: publicAccess,
        blurb: 'Open city sketches and rainy-night color studies.',
        coverPhotoSlug: 'market-rain',
        description:
            'A public set of poster-like sketches from tram stops, markets, and late evening walks.',
        photoSlugs: ['market-rain', 'neon-tram'],
        slug: 'city-postcards',
        title: 'City Postcards',
    },
    {
        access: friendsAccess,
        blurb: 'Private campfire art shared with friends.',
        coverPhotoSlug: 'campfire-choir',
        description:
            'A small, friends-only album from sketchbook pages that started as inside jokes.',
        photoSlugs: ['campfire-choir'],
        slug: 'friends-campfire',
        title: 'Friends Campfire',
    },
    {
        access: familyAccess,
        blurb: 'Family stories, attic memories, and old keepsakes.',
        coverPhotoSlug: 'attic-orbit',
        description:
            'An album kept inside the family circle because the notes and symbols are personal.',
        photoSlugs: ['attic-orbit'],
        slug: 'family-attic',
        title: 'Family Attic',
    },
    {
        access: publicAccess,
        blurb: 'Open sketchbook pages with one special-access photo.',
        coverPhotoSlug: 'paper-moons',
        description:
            'A mostly public studio notebook that includes one experimental piece behind a narrower scope.',
        photoSlugs: ['paper-moons', 'red-kite-at-dusk'],
        slug: 'studio-notes',
        title: 'Studio Notes',
    },
];

export function listAlbums(): readonly Album[] {
    return albums;
}

export function listPhotos(): readonly Photo[] {
    return photos;
}

export function getAlbum(slug: string): Album | undefined {
    return albums.find((album) => album.slug === slug);
}

export function getPhoto(slug: string): Photo | undefined {
    return photos.find((photo) => photo.slug === slug);
}

export function getPhotosForAlbum(albumSlug: string): readonly Photo[] {
    return photos.filter((photo) => photo.albumSlug === albumSlug);
}

export function getAlbumCover(album: Album): Photo {
    const cover = getPhoto(album.coverPhotoSlug);
    if (typeof cover === 'undefined') {
        throw new Error(`Album ${album.slug} is missing cover photo ${album.coverPhotoSlug}.`);
    }

    return cover;
}

export function getRelatedAlbum(photo: Photo): Album {
    const album = getAlbum(photo.albumSlug);
    if (typeof album === 'undefined') {
        throw new Error(`Photo ${photo.slug} references missing album ${photo.albumSlug}.`);
    }

    return album;
}
