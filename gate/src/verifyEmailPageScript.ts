// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Wojciech Polak

export const verifyEmailPageScript = `(() => {
  const currentUrl = new URL(window.location.href);
  if (!currentUrl.searchParams.has('token')) {
    return;
  }

  currentUrl.searchParams.delete('token');
  const nextSearch = currentUrl.searchParams.toString();
  const nextUrl = \`\${currentUrl.pathname}\${nextSearch ? \`?\${nextSearch}\` : ''}\${currentUrl.hash}\`;
  window.history.replaceState(null, '', nextUrl);
})();`;
