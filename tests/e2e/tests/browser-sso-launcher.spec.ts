// SPDX-License-Identifier: MIT
import { test, expect } from './helpers/browser-sso-test.js';
import { browserSsoOrigin } from '../src/browser-sso-fixture.js';
import {
    clearMailbox,
    listMessages,
    waitForMagicLink,
    waitForEmailOtp,
} from './helpers/mail-sink.js';

const issuer = browserSsoOrigin('issuer');
const gate = browserSsoOrigin('gate-a');

for (const method of ['link', 'otp']) {
    test(`launcher ${method}: sign in, open Gate and SDK, change account and end SSO`, async ({
        page,
        context,
        request,
    }, testInfo) => {
        await clearMailbox(request);
        await request.post(issuer + '/test/grant', {
            data: { site: '*', email: 'owner@example.com', allowed: true },
        });
        await request.post(issuer + '/test/grant', {
            data: { site: '*', email: 'other@example.com', allowed: false },
        });
        await request.post(issuer + '/test/grant', {
            data: { site: 'gate-b', email: 'other@example.com', allowed: true },
        });
        try {
            await page.goto(issuer + '/sso/apps');
            await expect(page.getByRole('link', { name: 'Open Documents' })).toHaveCount(0);
            await page.getByRole('button', { name: 'Sign in', exact: true }).click();
            await page.getByLabel('Email', { exact: true }).fill('owner@example.com');
            await page.getByRole('button', { name: /send|sign in/i }).click();
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
            await expect(page).toHaveURL(issuer + '/sso/apps');
            await expect(page.getByText('owner@example.com', { exact: true })).toBeVisible();
            await expect(
                page.getByRole('list', { name: 'Available applications' }).getByRole('link'),
            ).toHaveCount(3);
            await expect(page.getByRole('link', { name: 'Open Documents' })).toBeVisible();
            await page.screenshot({
                path: testInfo.outputPath('launcher-desktop.png'),
                fullPage: true,
            });
            await page.setViewportSize({ width: 375, height: 812 });
            await page.screenshot({
                path: testInfo.outputPath('launcher-mobile.png'),
                fullPage: true,
            });
            expect(
                await page.evaluate(
                    () => document.documentElement.scrollWidth <= window.innerWidth,
                ),
            ).toBe(true);
            const documentsOpened = page.waitForEvent('popup');
            await page.getByRole('link', { name: 'Open Documents' }).click();
            const documentsPage = await documentsOpened;
            await expect(documentsPage).toHaveURL(gate + '/reports?q=a%2Bb&tag=one&tag=two');
            await expect(documentsPage.getByTestId('email')).toHaveText('owner@example.com');
            expect(await documentsPage.evaluate(() => window.opener === null)).toBe(true);
            await expect(page).toHaveURL(issuer + '/sso/apps');
            const nextOpened = page.waitForEvent('popup');
            await page.getByRole('link', { name: 'Open Next.js application' }).click();
            const nextPage = await nextOpened;
            await expect(nextPage).toHaveURL(browserSsoOrigin('next') + '/protected');
            await expect(nextPage.getByText('owner@example.com', { exact: true })).toBeVisible();
            expect(await nextPage.evaluate(() => window.opener === null)).toBe(true);
            await expect(page).toHaveURL(issuer + '/sso/apps');
            expect(await listMessages(request)).toHaveLength(1);
            await documentsPage.close();
            await nextPage.close();
            await page.getByRole('button', { name: 'Change account' }).click();
            await page.getByLabel('Email', { exact: true }).fill('other@example.com');
            await page.getByRole('button', { name: /send|sign in/i }).click();
            await page.goto(
                await waitForMagicLink(request, {
                    recipient: 'other@example.com',
                    callbackUrlPrefix: issuer + '/sso/verify',
                }),
            );
            await expect(page.getByText('other@example.com', { exact: true })).toBeVisible();
            await page.getByRole('button', { name: /continue|confirm/i }).click();
            await expect(page).toHaveURL(issuer + '/sso/apps');
            await expect(page.getByRole('link', { name: 'Open Photos' })).toBeVisible();
            await expect(page.getByRole('link', { name: 'Open Documents' })).toHaveCount(0);
            await expect(page.getByRole('link', { name: 'Open Next.js application' })).toHaveCount(
                0,
            );
            await page.goto(gate + '/reports');
            await expect(page.getByTestId('email')).toHaveText('owner@example.com');
            await page.goto(issuer + '/sso/apps');
            await request.post(issuer + '/test/grant', {
                data: { site: 'gate-b', email: 'other@example.com', allowed: false },
            });
            await page.reload();
            await expect(
                page.getByRole('heading', { name: 'No applications available' }),
            ).toBeVisible();
            await page.getByRole('link', { name: 'End browser SSO session' }).click();
            await page.getByRole('button', { name: 'End browser SSO session' }).click();
            await expect(page).toHaveURL(issuer + '/sso/apps');
            await expect(page.getByRole('button', { name: 'Sign in', exact: true })).toBeVisible();
            expect(
                (await context.cookies(issuer)).some((cookie) =>
                    cookie.name.endsWith('magic-sso-browser'),
                ),
            ).toBe(false);
            await page.goto(gate + '/reports');
            await expect(page.getByTestId('email')).toHaveText('owner@example.com');
        } finally {
            await request.post(issuer + '/test/grant', {
                data: { site: '*', email: 'owner@example.com', allowed: true },
            });
            await request.post(issuer + '/test/grant', {
                data: { site: '*', email: 'other@example.com', allowed: false },
            });
        }
    });
}
