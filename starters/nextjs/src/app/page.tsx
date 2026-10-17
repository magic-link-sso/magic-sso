// SPDX-License-Identifier: MIT
import type { ReactElement } from 'react';
import Link from 'next/link';

export default function Home(): ReactElement {
  return (
    <>
      <h1>Magic Link SSO starter</h1>
      <p>This page is public. Open the private page to sign in with your email.</p>
      <Link href="/private">Open private page</Link>
    </>
  );
}
