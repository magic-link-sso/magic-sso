// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Wojciech Polak

import type { Metadata } from 'next';
import 'magic-sso-example-ui/styles.css';

export const metadata: Metadata = {
  title: 'Magic Link SSO Next.js',
  description: 'Sample Magic Link SSO in Next.js',
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}
