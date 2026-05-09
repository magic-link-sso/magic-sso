// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Wojciech Polak

import type { Metadata } from 'next';
import Image from 'next/image';
import Link from 'next/link';
import { notFound } from 'next/navigation';
import React from 'react';
import { AccessPanel, PhotoTile, SiteHeader } from '@/components/photos-ui';
import { hasAccess } from '@/lib/access';
import { getAlbum, getAlbumCover, getPhotosForAlbum } from '@/lib/gallery';
import { readViewer } from '@/lib/viewer';

interface AlbumPageProps {
  readonly params: Promise<{
    albumSlug: string;
  }>;
}

export async function generateMetadata({ params }: AlbumPageProps): Promise<Metadata> {
  const { albumSlug } = await params;
  const album = getAlbum(albumSlug);

  return {
    title: album
      ? `${album.title} | Magic Link SSO Photos Demo`
      : 'Album | Magic Link SSO Photos Demo',
  };
}

export default async function AlbumPage({ params }: AlbumPageProps): Promise<React.JSX.Element> {
  const { albumSlug } = await params;
  const album = getAlbum(albumSlug);
  if (typeof album === 'undefined') {
    notFound();
  }

  const viewer = await readViewer();
  const cover = getAlbumCover(album);
  const photos = getPhotosForAlbum(album.slug);
  const albumPath = `/albums/${album.slug}`;
  const canViewAlbum = hasAccess(viewer, album.access);

  return (
    <main className="app-shell">
      <SiteHeader viewer={viewer} />

      <div className="section-head">
        <div>
          <p className="eyebrow">Album</p>
          <h1 className="section-title">{album.title}</h1>
        </div>
        <Link href="/" className="button button-ghost">
          Back to gallery
        </Link>
      </div>

      <section className="story-layout">
        <article className="story-card">
          <div className="detail-frame">
            <Image
              src={cover.artworkPath}
              alt={cover.alt}
              className="detail-artwork"
              width={1200}
              height={900}
              unoptimized
            />
          </div>
        </article>

        <aside className="story-card">
          <div className="detail-meta">
            <span className="chip chip-ink">{album.access.label}</span>
            <span className="chip">{album.photoSlugs.length} works</span>
          </div>
          <p className="panel-eyebrow">Collection note</p>
          <h2 className="panel-title">{album.blurb}</h2>
          <p>{album.description}</p>
          <p>
            This page stays SSR so anonymous visitors can see public albums immediately, while
            members-only albums render a request-access card before any private art appears.
          </p>
        </aside>
      </section>

      {canViewAlbum ? (
        <section>
          <div className="section-head">
            <div>
              <p className="eyebrow">Works</p>
              <h2 className="section-title">Inside {album.title}</h2>
            </div>
          </div>

          <div className="photo-grid">
            {photos.map((photo) => (
              <PhotoTile key={photo.slug} photo={photo} viewer={viewer} />
            ))}
          </div>
        </section>
      ) : (
        <AccessPanel
          description="Request the matching access level and come right back to this album. Manager-managed grants change the rendered catalog immediately after apply."
          requirement={album.access}
          returnPath={albumPath}
          title={`${album.title} is reserved for ${album.access.label.toLowerCase()} members.`}
          viewer={viewer}
        />
      )}
    </main>
  );
}
