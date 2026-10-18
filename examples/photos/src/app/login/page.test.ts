// SPDX-License-Identifier: MIT
import { renderToStaticMarkup } from 'react-dom/server';
import { afterEach, expect, it, vi } from 'vitest';
import LoginPage from './page';

vi.mock('next/headers', () => ({ headers: async (): Promise<Headers> => new Headers() }));

afterEach((): void => {
    vi.unstubAllEnvs();
});

it('keeps the legacy login page available when automatic SSO falls back', async (): Promise<void> => {
    vi.stubEnv('MAGICSSO_BROWSER_SSO_MODE', 'auto');
    vi.stubEnv('MAGICSSO_PUBLIC_ORIGIN', 'http://photos.localhost:46006');
    const html = renderToStaticMarkup(
        await LoginPage({
            searchParams: Promise.resolve({
                returnUrl: '/albums/friends-campfire',
                scope: 'friends',
            }),
        }),
    );
    expect(html).toContain('action="/api/signin"');
    expect(html).toContain('type="email"');
    expect(html).toContain('value="friends"');
});
