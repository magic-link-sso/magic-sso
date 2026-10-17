// SPDX-License-Identifier: MIT
import { redirectToLogin, verifyToken } from '@magic-link-sso/nextjs';
import type { ReactElement } from 'react';

export default async function PrivatePage(): Promise<ReactElement> {
  const identity = await verifyToken();
  if (identity === null) {
    redirectToLogin('/private');
  }
  return (
    <>
      <h1>You are signed in</h1>
      <p>Signed in as {identity.email}</p>
      <form method="post" action="/logout">
        <button type="submit">Sign out</button>
      </form>
    </>
  );
}
