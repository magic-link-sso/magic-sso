// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Wojciech Polak

import type { JSX } from 'react';
import Image from 'next/image';
import Link from 'next/link';
import {
  buildLoginHref,
  getAccessState,
  getScopeDisplayName,
  getViewerScopeSummary,
  hasAccess,
  type ViewerSession,
  type AccessRequirement,
} from '@/lib/access';
import type { Album, Photo } from '@/lib/gallery';

export interface AccessPanelProps {
  readonly description: string;
  readonly requirement: AccessRequirement;
  readonly returnPath: string;
  readonly title: string;
  readonly viewer: ViewerSession;
}

function renderAccessCta(
  requirement: AccessRequirement,
  returnPath: string,
  viewer: ViewerSession,
): JSX.Element {
  const accessState = getAccessState(viewer, requirement);
  const href = buildLoginHref(returnPath, requirement);
  const requirementDescription = requirement.label.toLowerCase().includes('access')
    ? requirement.label.toLowerCase()
    : `${requirement.label.toLowerCase()} access`;
  const buttonText =
    accessState === 'switch-scope' ? 'Switch access level' : 'Request access with Magic Link';
  const note =
    accessState === 'switch-scope'
      ? `You are signed in, but this page needs ${requirementDescription}.`
      : `This page needs ${requirementDescription}.`;

  return (
    <>
      <p className="access-note">{note}</p>
      <Link href={href} className="button button-primary">
        {buttonText}
      </Link>
    </>
  );
}

export function SiteHeader({ viewer }: { readonly viewer: ViewerSession }): JSX.Element {
  return (
    <header className="site-header">
      <Link href="/" className="site-brand">
        <span className="brand-mark">ML</span>
        <span>
          <span className="brand-kicker">Magic Link SSO</span>
          <span className="brand-title">Photos Demo</span>
        </span>
      </Link>

      <div className="site-actions">
        {viewer === null ? (
          <Link href="/login?returnUrl=%2F" className="button button-ghost">
            Sign in
          </Link>
        ) : (
          <form action="/logout" method="post">
            <button type="submit" className="button button-ghost">
              Sign out
            </button>
          </form>
        )}
      </div>
    </header>
  );
}

export function ViewerPanel({ viewer }: { readonly viewer: ViewerSession }): JSX.Element {
  return (
    <section className="viewer-panel">
      <div>
        <p className="panel-eyebrow">Viewer</p>
        <h2 className="panel-title">
          {viewer === null ? 'Anonymous browsing is enabled.' : viewer.email}
        </h2>
      </div>
      <div className="viewer-chips">
        <span className="chip chip-ink">{getViewerScopeSummary(viewer)}</span>
        <span className="chip">{viewer === null ? 'No session cookie' : viewer.siteId}</span>
      </div>
    </section>
  );
}

export function AccessPanel({
  description,
  requirement,
  returnPath,
  title,
  viewer,
}: AccessPanelProps): JSX.Element {
  return (
    <section className="access-panel">
      <p className="panel-eyebrow">Members only</p>
      <h2 className="access-title">{title}</h2>
      <p className="access-copy">{description}</p>
      <div className="access-meta">
        <span className="chip chip-ink">{requirement.label}</span>
        {typeof requirement.scope === 'string' && (
          <span className="chip">{getScopeDisplayName(requirement.scope)}</span>
        )}
      </div>
      {renderAccessCta(requirement, returnPath, viewer)}
    </section>
  );
}

export function AlbumCard({
  album,
  coverPhoto,
  viewer,
}: {
  readonly album: Album;
  readonly coverPhoto: Photo;
  readonly viewer: ViewerSession;
}): JSX.Element {
  const albumHref = `/albums/${album.slug}`;
  const isUnlocked = hasAccess(viewer, album.access);

  return (
    <article className="album-card">
      <Link href={albumHref} className="album-cover-link">
        <Image
          src={coverPhoto.artworkPath}
          alt={coverPhoto.alt}
          className="album-cover"
          width={1200}
          height={900}
          unoptimized
        />
      </Link>
      <div className="album-copy">
        <div className="album-meta">
          <span className={`chip ${isUnlocked ? 'chip-ink' : ''}`}>{album.access.label}</span>
          <span className="chip">{album.photoSlugs.length} works</span>
        </div>
        <h3 className="album-title">
          <Link href={albumHref}>{album.title}</Link>
        </h3>
        <p className="album-blurb">{album.blurb}</p>
        <p className="album-description">{album.description}</p>
      </div>
    </article>
  );
}

export function PhotoTile({
  photo,
  viewer,
}: {
  readonly photo: Photo;
  readonly viewer: ViewerSession;
}): JSX.Element {
  const isUnlocked = hasAccess(viewer, photo.access);
  const photoHref = `/photos/${photo.slug}`;

  return (
    <article className="photo-tile">
      <Link href={photoHref} className="photo-link">
        {isUnlocked ? (
          <Image
            src={photo.artworkPath}
            alt={photo.alt}
            className="photo-art"
            width={1200}
            height={900}
            unoptimized
          />
        ) : (
          <div className="photo-locked">
            <span className="locked-mark">Locked</span>
            <p>{photo.access.label}</p>
          </div>
        )}
      </Link>
      <div className="photo-meta">
        <div className="album-meta">
          <span className={`chip ${isUnlocked ? 'chip-ink' : ''}`}>{photo.access.label}</span>
          <span className="chip">{photo.year}</span>
        </div>
        <h3 className="photo-title">
          <Link href={photoHref}>{photo.title}</Link>
        </h3>
        <p className="photo-caption">{photo.blurb}</p>
      </div>
    </article>
  );
}
