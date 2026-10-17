// SPDX-License-Identifier: MIT
import type { ReactElement, ReactNode } from 'react';

export const metadata = { title: 'Magic Link SSO starter' };

export default function RootLayout({ children }: { children: ReactNode }): ReactElement {
  return (
    <html lang="en">
      <body>
        <main>{children}</main>
      </body>
    </html>
  );
}
