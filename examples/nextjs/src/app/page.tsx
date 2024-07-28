// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Wojciech Polak
// src/app/page.tsx

import React from 'react';
import Image from 'next/image';
import Link from 'next/link';
import { headers } from 'next/headers';
import { signinBadgeUrl } from 'magic-sso-example-ui';
import { verifyToken } from '@magic-link-sso/nextjs';
import { buildLoginTarget, getAppOrigin } from './login/url';

export default async function HomePage(): Promise<React.JSX.Element> {
  const auth = await verifyToken();
  const headerStore = await headers();
  const host = headerStore.get('x-forwarded-host') ?? headerStore.get('host') ?? 'localhost:3001';
  const loginTarget = buildLoginTarget(getAppOrigin(host, headerStore.get('x-forwarded-proto')));

  return (
    <main className="shell">
      <div className="card hero">
        <div className="hero-top">
          <Image
            src={signinBadgeUrl}
            alt="Sign-in flow badge"
            width={144}
            height={144}
            className="badge"
            loading="eager"
            unoptimized
          />
          <div>
            <p className="eyebrow">Magic Link SSO</p>
            <h1 className="title">Next.js demo app for Magic Link sign-in.</h1>
            <p className="copy">
              Start the sign-in flow here, then open a protected route once your session cookie is
              in place.
            </p>
          </div>
        </div>

        <div className="grid">
          <section className="panel">
            <p className="panel-title">Session Status</p>
            {auth ? (
              <p className="panel-copy">
                Signed in as <strong>{auth.email}</strong>. Your token is already active for
                protected routes.
              </p>
            ) : (
              <p className="panel-copy">
                You are not signed in yet. Start with the login page, then come back here to see the
                authenticated state.
              </p>
            )}
          </section>

          <section className="panel panel-dark">
            <p className="panel-title">Quick Actions</p>
            <div className="actions">
              {auth ? (
                <>
                  <Link href="/protected" className="button button-light">
                    Open Protected Page
                  </Link>
                  <form action="/logout" method="post">
                    <button type="submit" className="button button-secondary">
                      Logout
                    </button>
                  </form>
                </>
              ) : (
                <>
                  <Link href={loginTarget} className="button button-light">
                    Login
                  </Link>
                  <Link href="/protected" className="button button-secondary">
                    Try Protected Page
                  </Link>
                </>
              )}
            </div>
          </section>
        </div>
      </div>
    </main>
  );
}
