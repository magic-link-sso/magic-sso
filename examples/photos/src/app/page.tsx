// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Wojciech Polak

import React from 'react';
import Link from 'next/link';
import { AlbumCard, SiteHeader, ViewerPanel } from '@/components/photos-ui';
import { getAlbumCover, listAlbums } from '@/lib/gallery';
import { readViewer } from '@/lib/viewer';

export default async function HomePage(): Promise<React.JSX.Element> {
  const viewer = await readViewer();
  const albums = listAlbums();

  return (
    <main className="app-shell">
      <SiteHeader viewer={viewer} />

      <section className="hero">
        <article className="hero-card">
          <div className="hero-grid">
            <div>
              <p className="eyebrow">Magic Link SSO</p>
              <h1 className="hero-title">Photo-sharing demo for managed-mode access</h1>
            </div>
            <p className="hero-copy">
              Browse public albums anonymously, then use Magic Link SSO to unlock friends-only,
              family-only, or single-photo access. This app is read-only by design so the demo stays
              focused on how manager-owned grants and scopes change the actual experience.
            </p>
            <div className="hero-points">
              <div className="point">
                <strong>Public pages</strong>
                <span>Anyone can open public albums and public photos without a session.</span>
              </div>
              <div className="point">
                <strong>Scoped sessions</strong>
                <span>
                  Friends, family, and photo-specific viewers each see a different catalog.
                </span>
              </div>
              <div className="point">
                <strong>SSR gating</strong>
                <span>
                  Restricted pages render access cards server-side instead of leaking content.
                </span>
              </div>
              <div className="point">
                <strong>Manager-ready</strong>
                <span>
                  Use the Manager UI to add the special photo scope live and test it immediately.
                </span>
              </div>
            </div>
            <div className="detail-nav">
              <Link href="/albums/studio-notes" className="button button-primary">
                Open Studio Notes
              </Link>
              <Link href="/photos/red-kite-at-dusk" className="button button-ghost">
                Visit Locked Photo
              </Link>
            </div>
          </div>
        </article>

        <ViewerPanel viewer={viewer} />
      </section>

      <section>
        <div className="section-head">
          <div>
            <p className="eyebrow">Albums</p>
            <h2 className="section-title">Gallery access changes with the signed-in scope.</h2>
          </div>
          <Link href="/login?returnUrl=%2F" className="button button-ghost">
            {viewer === null ? 'Sign in for private albums' : 'Request a different scope'}
          </Link>
        </div>

        <div className="album-grid">
          {albums.map((album) => (
            <AlbumCard
              key={album.slug}
              album={album}
              coverPhoto={getAlbumCover(album)}
              viewer={viewer}
            />
          ))}
        </div>
      </section>
    </main>
  );
}
