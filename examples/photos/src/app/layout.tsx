// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Wojciech Polak

import type { Metadata } from 'next';
import './globals.css';

export const metadata: Metadata = {
  title: 'Magic Link SSO Photos Demo',
  description: 'Managed-mode SSR Photos demo for Magic Link SSO',
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
