// SPDX-License-Identifier: MIT
import type { Page } from '@playwright/test';
import { test, expect } from './helpers/browser-sso-test.js';
import { canonicalFlowUrl } from '../../../packages/core/test/sign-in-contract.js';
import {
    clearMailbox,
    listMessages,
    waitForMagicLink,
    waitForEmailOtp,
} from './helpers/mail-sink.js';

import { browserSsoOrigin, browserSsoHttps } from '../src/browser-sso-fixture.js';
const issuer = browserSsoOrigin('issuer');
interface BrowserApp {
    origin: string;
    protectedPath: string;
    signedOut: string;
    site: string;
    kind: 'gate' | 'next' | 'nuxt' | 'django' | 'angular' | 'fastify';
}
const apps: BrowserApp[] = [
    {
        origin: browserSsoOrigin('gate-a'),
        protectedPath: '/reports',
        signedOut: '/_magicgate/signed-out',
        site: 'gate-a',
        kind: 'gate',
    },
    {
        origin: browserSsoOrigin('gate-b'),
        protectedPath: '/private/reports',
        signedOut: '/private/_access/signed-out',
        site: 'gate-b',
        kind: 'gate',
    },
];
const query = '?q=a%2Bb%20%26%20c&tag=one&tag=two';
const next: BrowserApp = {
    origin: browserSsoOrigin('next'),
    protectedPath: '/protected',
    signedOut: '/sso/signed-out',
    site: 'next',
    kind: 'next',
};
const firstGate = apps[0];
if (!firstGate) {
    throw new Error('Missing Gate fixture');
}

async function expectApplication(page: Page, app: BrowserApp): Promise<void> {
    if (app.kind === 'next') {
        await expect(
            page.getByRole('heading', { name: 'Your Next.js session is locked in and verified.' }),
        ).toBeVisible();
        await expect(page.getByText('owner@example.com', { exact: true })).toBeVisible();
    } else if (app.kind !== 'gate') {
        await expect(page.getByText('owner@example.com', { exact: true })).toBeVisible();
        expect(await page.content()).not.toContain('test-browser-sso-jwt-secret');
    } else {
        await expect(page.getByTestId('site')).toHaveText(app.site);
        await expect(page.getByTestId('email')).toHaveText('owner@example.com');
    }
}

for (const pair of [
    { name: 'Gate ↔ Gate', apps },
    { name: 'Gate ↔ Next.js', apps: [firstGate, next] },
]) {
    for (const reverse of [false, true]) {
        for (const method of ['link', 'otp']) {
            test(`${pair.name} browser SSO ${reverse ? 'B → A' : 'A → B'} after one hosted ${method}`, async ({
                page,
                context,
                request,
            }) => {
                await clearMailbox(request);
                const order = reverse ? [...pair.apps].reverse() : pair.apps;
                const [first, second] = order;
                if (!first || !second) {
                    throw new Error('Missing sites');
                }
                await page.goto(`${first.origin}${first.protectedPath}${query}`);
                await expect(page).toHaveURL(
                    new RegExp(`^${issuer.replaceAll('.', '\\.')}/sso/authorize\\?`),
                );
                await page.getByLabel('Email', { exact: true }).fill('owner@example.com');
                await page.getByLabel('Email', { exact: true }).press('Enter');
                if (method === 'link') {
                    const link = await waitForMagicLink(request, {
                        recipient: 'owner@example.com',
                        callbackUrlPrefix: `${issuer}/sso/verify`,
                    });
                    await page.goto(link);
                    await expect(
                        page.getByText('owner@example.com', { exact: true }),
                    ).toBeVisible();
                    await page.getByRole('button', { name: /continue|confirm/i }).click();
                } else {
                    const code = await waitForEmailOtp(request, { recipient: 'owner@example.com' });
                    await page.getByLabel(/one-time code/i).fill(code);
                    await page.getByRole('button', { name: /code/i }).click();
                }
                await expect(page).toHaveURL(
                    (url) =>
                        canonicalFlowUrl(url.href) ===
                        canonicalFlowUrl(`${first.origin}${first.protectedPath}${query}`),
                );
                await expectApplication(page, first);
                await page.goto(`${second.origin}${second.protectedPath}${query}`);
                await expect(page).toHaveURL(
                    (url) =>
                        canonicalFlowUrl(url.href) ===
                        canonicalFlowUrl(`${second.origin}${second.protectedPath}${query}`),
                );
                await expectApplication(page, second);
                expect(await listMessages(request)).toHaveLength(1);
                const jar = await context.cookies();
                const central = jar.find(
                    (cookie) =>
                        cookie.name === `${browserSsoHttps ? '__Host-' : ''}magic-sso-browser`,
                );
                expect(central?.domain).toBe(new URL(issuer).hostname);
                expect(
                    jar
                        .filter((cookie) => cookie.name === 'magic-sso')
                        .map((cookie) => cookie.domain)
                        .sort(),
                ).toEqual([new URL(first.origin).hostname, new URL(second.origin).hostname].sort());
                expect(
                    (await context.cookies([first.origin, second.origin])).some(
                        (cookie) =>
                            cookie.name === `${browserSsoHttps ? '__Host-' : ''}magic-sso-browser`,
                    ),
                ).toBe(false);
                expect(jar.some((cookie) => cookie.name.includes('magic-sso-tx-'))).toBe(false);
                await page.getByRole('button', { name: 'Sign out of this application' }).click();
                await expect(page).toHaveURL(`${second.origin}${second.signedOut}`);
                await expect(
                    page.getByRole('heading', { name: 'Signed out of this application' }),
                ).toBeVisible();
                await page.goto(`${first.origin}${first.protectedPath}${query}`);
                await expectApplication(page, first);
                await page.goto(`${second.origin}${second.signedOut}`);
                await page.getByRole('link', { name: 'Sign in', exact: true }).click();
                await page.goto(`${second.origin}${second.protectedPath}${query}`);
                await expectApplication(page, second);
                expect(await listMessages(request)).toHaveLength(1);
            });
        }
    }
}

test('Next.js home sign-in uses hosted browser SSO when enabled', async ({ page, request }) => {
    await clearMailbox(request);
    await page.goto(next.origin);
    await page.getByRole('link', { name: 'Login', exact: true }).click();
    await expect(page).toHaveURL(
        (url) => url.origin === issuer && url.pathname === '/sso/authorize',
    );
    await expect(page.getByLabel('Email', { exact: true })).toBeVisible();
    expect(await listMessages(request)).toHaveLength(0);
});

const ring: BrowserApp[] = [
    firstGate,
    next,
    ...(['nuxt', 'django', 'angular', 'fastify'] as const).map((kind) => ({
        // Literal framework names retain the BrowserApp kind union.
        kind,
        site: kind,
        origin: browserSsoOrigin(kind),
        protectedPath: kind === 'django' ? '/protected1' : '/protected',
        signedOut: `/sso/signed-out${kind === 'django' ? '/' : ''}`,
    })),
];
for (const method of ['link', 'otp']) {
    test(`all adapters reuse one hosted ${method} around the integration ring`, async ({
        page,
        request,
        context,
    }) => {
        await clearMailbox(request);
        const first = ring[0];
        if (!first) {
            throw new Error('Missing ring');
        }
        await page.goto(first.origin + first.protectedPath + query);
        await page.getByLabel('Email', { exact: true }).fill('owner@example.com');
        await page.getByLabel('Email', { exact: true }).press('Enter');
        if (method === 'link') {
            await page.goto(
                await waitForMagicLink(request, {
                    recipient: 'owner@example.com',
                    callbackUrlPrefix: issuer + '/sso/verify',
                }),
            );
            await page.getByRole('button', { name: /continue|confirm/i }).click();
        } else {
            await page
                .getByLabel(/one-time code/i)
                .fill(await waitForEmailOtp(request, { recipient: 'owner@example.com' }));
            await page.getByRole('button', { name: /code/i }).click();
        }
        for (const app of [...ring, first]) {
            await page.goto(app.origin + app.protectedPath + query);
            await expect(page).toHaveURL(
                (url) =>
                    canonicalFlowUrl(url.href) ===
                    canonicalFlowUrl(app.origin + app.protectedPath + query),
            );
            await expectApplication(page, app);
        }
        expect(await listMessages(request)).toHaveLength(1);
        const jar = await context.cookies();
        expect(jar.filter((cookie) => cookie.name === 'magic-sso')).toHaveLength(ring.length);
        expect(jar.some((cookie) => cookie.name.includes('magic-sso-tx-'))).toBe(false);
        for (const app of ring.slice(2)) {
            await page.goto(app.origin + app.protectedPath);
            await page.getByRole('button', { name: 'Sign out of this application' }).click();
            await expect(page).toHaveURL(app.origin + app.signedOut);
            expect(
                (await context.cookies(app.origin)).some((cookie) => cookie.name === 'magic-sso'),
            ).toBe(false);
        }
        await page.goto(first.origin + first.protectedPath);
        await expectApplication(page, first);
        expect(await listMessages(request)).toHaveLength(1);
    });
}
