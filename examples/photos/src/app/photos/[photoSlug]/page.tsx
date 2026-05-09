// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Wojciech Polak

import type { Metadata } from 'next';
import Image from 'next/image';
import Link from 'next/link';
import { notFound } from 'next/navigation';
import React from 'react';
import { AccessPanel, SiteHeader } from '@/components/photos-ui';
import { hasAccess } from '@/lib/access';
import { getPhoto, getRelatedAlbum } from '@/lib/gallery';
import { readViewer } from '@/lib/viewer';

interface PhotoPageProps {
  readonly params: Promise<{
    photoSlug: string;
  }>;
}

export async function generateMetadata({ params }: PhotoPageProps): Promise<Metadata> {
  const { photoSlug } = await params;
  const photo = getPhoto(photoSlug);

  return {
    title: photo
      ? `${photo.title} | Magic Link SSO Photos Demo`
      : 'Photo | Magic Link SSO Photos Demo',
  };
}

export default async function PhotoPage({ params }: PhotoPageProps): Promise<React.JSX.Element> {
  const { photoSlug } = await params;
  const photo = getPhoto(photoSlug);
  if (typeof photo === 'undefined') {
    notFound();
  }

  const viewer = await readViewer();
  const album = getRelatedAlbum(photo);
  const photoPath = `/photos/${photo.slug}`;
  const canViewPhoto = hasAccess(viewer, photo.access) && hasAccess(viewer, album.access);

  return (
    <main className="app-shell">
      <SiteHeader viewer={viewer} />

      <div className="section-head">
        <div>
          <p className="eyebrow">Photo</p>
          <h1 className="section-title">{photo.title}</h1>
        </div>
        <Link href={`/albums/${album.slug}`} className="button button-ghost">
          Back to {album.title}
        </Link>
      </div>

      {canViewPhoto ? (
        <section className="detail-layout">
          <article className="detail-card">
            <div className="detail-frame">
              <Image
                src={photo.artworkPath}
                alt={photo.alt}
                className="detail-artwork"
                width={1200}
                height={900}
                unoptimized
              />
            </div>
          </article>

          <aside className="detail-card">
            <div className="detail-meta">
              <span className="chip chip-ink">{photo.access.label}</span>
              <span className="chip">{photo.year}</span>
              <span className="chip">{album.title}</span>
            </div>
            <p className="panel-eyebrow">About this work</p>
            <h2 className="detail-title">{photo.title}</h2>
            <p className="detail-copy">{photo.caption}</p>
            {viewer !== null && (
              <p className="detail-caption">
                Signed in as <strong>{viewer.email}</strong> with{' '}
                {viewer.scope === '*' ? 'owner access' : viewer.scope}.
              </p>
            )}
            <p className="detail-caption">{photo.blurb}</p>
            <div className="detail-nav">
              <Link href="/" className="button button-ghost">
                Gallery home
              </Link>
              <Link href={`/albums/${album.slug}`} className="button button-primary">
                Open album
              </Link>
            </div>
          </aside>
        </section>
      ) : (
        <AccessPanel
          description="This photo demonstrates the narrowest access rule in the demo: one specific piece inside a broader album. Grant the matching scope in Manager and then retry the same URL."
          requirement={photo.access}
          returnPath={photoPath}
          title={`${photo.title} needs the dedicated photo scope.`}
          viewer={viewer}
        />
      )}
    </main>
  );
}
