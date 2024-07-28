// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Wojciech Polak
// src/app/protected/page.tsx

import type { Metadata } from 'next';
import React from 'react';
import Image from 'next/image';
import Link from 'next/link';
import { protectedBadgeUrl } from 'magic-sso-example-ui';
import { verifyToken, redirectToLogin } from '@magic-link-sso/nextjs';

export const metadata: Metadata = {
  title: 'Protected | Magic Link SSO Next.js',
};

export default async function ProtectedPage(): Promise<React.JSX.Element | null> {
  const auth = await verifyToken();

  if (!auth) {
    redirectToLogin('/protected');
    return null;
  }

  return (
    <main className="shell">
      <div className="card hero">
        <div className="hero-top">
          <Image
            src={protectedBadgeUrl}
            alt="Protected area badge"
            width={144}
            height={144}
            className="badge"
            unoptimized
          />
          <div>
            <p className="eyebrow">Protected Space</p>
            <h1 className="title">Your Next.js session is locked in and verified.</h1>
            <p className="copy">
              Hello, <strong>{auth.email}</strong>. This page is available only after a valid Magic
              Link SSO token is confirmed.
            </p>
          </div>
        </div>

        <div className="meta-row">
          <section className="panel panel-dark">
            <p className="panel-title">Protected Route</p>
            <p className="panel-copy">
              This page uses the reusable <code>verifyToken()</code> and{' '}
              <code>redirectToLogin()</code> server helpers.
            </p>
          </section>

          <section className="panel">
            <p className="panel-title">Next Steps</p>
            <div className="actions">
              <Link href="/" className="button button-primary">
                Back Home
              </Link>
              <form action="/logout" method="post">
                <button type="submit" className="button button-secondary">
                  Logout
                </button>
              </form>
            </div>
          </section>
        </div>
      </div>
    </main>
  );
}
