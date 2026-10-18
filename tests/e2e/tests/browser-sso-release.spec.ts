// SPDX-License-Identifier: MIT
import type { APIRequestContext, Page } from '@playwright/test';
import { test, expect } from './helpers/browser-sso-test.js';
import { browserSsoOrigin } from '../src/browser-sso-fixture.js';
import {
    clearMailbox,
    listMessages,
    waitForEmailOtp,
    waitForMagicLink,
} from './helpers/mail-sink.js';
const issuer = browserSsoOrigin('issuer');
const first = browserSsoOrigin('gate-a');
const second = browserSsoOrigin('next');
async function grant(
    request: APIRequestContext,
    site: string,
    email: string,
    allowed: boolean,
): Promise<void> {
    const response = await request.post(issuer + '/test/grant', { data: { site, email, allowed } });
    expect(response.ok()).toBe(true);
}
async function signin(
    page: Page,
    request: APIRequestContext,
    email = 'owner@example.com',
): Promise<void> {
    await page.getByLabel('Email', { exact: true }).fill(email);
    await page.getByRole('button', { name: /send|sign in/i }).click();
    await page
        .getByLabel(/one-time code/i)
        .fill(await waitForEmailOtp(request, { recipient: email }));
    await page.getByRole('button', { name: /code/i }).click();
}
async function loginFirst(page: Page, request: APIRequestContext): Promise<void> {
    await page.goto(first + '/reports');
    await signin(page, request);
    await expect(page.getByTestId('email')).toHaveText('owner@example.com');
}
async function metrics(request: APIRequestContext): Promise<number> {
    const document: unknown = await (await request.get(issuer + '/test/metrics')).json();
    if (
        typeof document !== 'object' ||
        document === null ||
        !('exchanges' in document) ||
        typeof document.exchanges !== 'number'
    ) {
        throw new Error('Invalid test metrics');
    }
    return document.exchanges;
}
test.beforeEach(async ({ request }) => {
    await clearMailbox(request);
    await grant(request, '*', 'owner@example.com', true);
    await grant(request, '*', 'other@example.com', true);
});
for (const role of ['nuxt', 'django', 'angular', 'fastify'] as const) {
    // Literal roles match the fixture's trusted origin map.
    test(`${role} home entry uses a top-level hosted sign-in`, async ({ page, request }) => {
        await page.goto(browserSsoOrigin(role));
        await page.getByRole('link', { name: 'Login', exact: true }).click();
        await expect(page).toHaveURL(
            (url) => url.origin === issuer && url.pathname === '/sso/authorize',
        );
        await expect(page.getByLabel('Email', { exact: true })).toBeVisible();
        expect(await listMessages(request)).toHaveLength(0);
    });
}
test('denied B neither authenticates nor sends another email; a fresh live grant permits reuse', async ({
    page,
    request,
    context,
}) => {
    await loginFirst(page, request);
    await grant(request, 'next', 'owner@example.com', false);
    await page.goto(second + '/protected');
    await expect(
        page.getByText(
            'This account does not have access to the application. You can sign in with a different account.',
            { exact: true },
        ),
    ).toBeVisible();
    expect((await context.cookies(second)).some((cookie) => cookie.name === 'magic-sso')).toBe(
        false,
    );
    expect(await listMessages(request)).toHaveLength(1);
    await grant(request, 'next', 'owner@example.com', true);
    await page.goto(second + '/protected');
    await expect(page.getByText('owner@example.com', { exact: true })).toBeVisible();
    expect(await listMessages(request)).toHaveLength(1);
});
test('a grant removed after authorize is checked again at exchange', async ({
    page,
    request,
    context,
}) => {
    await loginFirst(page, request);
    await request.post(issuer + '/test/pause-authorization');
    await page.goto(second + '/protected');
    await expect(page.getByRole('heading', { name: 'Paused before callback' })).toBeVisible();
    await grant(request, 'next', 'owner@example.com', false);
    const paused: unknown = await (await request.get(issuer + '/test/paused-callback')).json();
    if (
        typeof paused !== 'object' ||
        paused === null ||
        !('callback' in paused) ||
        typeof paused.callback !== 'string'
    ) {
        throw new Error('Missing paused callback');
    }
    await page.goto(paused.callback);
    await expect(
        page.getByRole('heading', { name: 'Sign-in could not be completed' }),
    ).toBeVisible();
    expect((await context.cookies(second)).some((cookie) => cookie.name === 'magic-sso')).toBe(
        false,
    );
    expect(await listMessages(request)).toHaveLength(1);
});
test('central account replacement preserves valid A; clearing A allows the new identity', async ({
    page,
    request,
}) => {
    await loginFirst(page, request);
    await page.goto(second + '/sso/start?prompt=login&returnUrl=%2Fprotected');
    await signin(page, request, 'other@example.com');
    await expect(page.getByText('other@example.com', { exact: true })).toBeVisible();
    await page.goto(first + '/reports');
    await expect(page.getByTestId('email')).toHaveText('owner@example.com');
    await page.getByRole('button', { name: 'Sign out of this application' }).click();
    await page.goto(first + '/reports');
    // The fixture upstream reports the forwarded email, including a replacement account.
    await expect(page.getByTestId('email')).toHaveText('other@example.com');
    expect(await listMessages(request)).toHaveLength(2);
});
test('central sign-out prevents reuse while another valid app session stays active', async ({
    page,
    request,
    context,
}) => {
    await loginFirst(page, request);
    await page.goto(second + '/protected');
    await page.getByRole('button', { name: 'Sign out of this application' }).click();
    await page.getByRole('link', { name: 'End browser SSO session' }).click();
    await page.getByRole('button', { name: /sign out|end/i }).click();
    expect(
        (await context.cookies(issuer)).some(
            (cookie) => cookie.name === '__Host-magic-sso-browser',
        ),
    ).toBe(false);
    await page.goto(first + '/reports');
    await expect(page.getByTestId('email')).toHaveText('owner@example.com');
    await page.goto(second + '/protected');
    await expect(page.getByLabel('Email', { exact: true })).toBeVisible();
    expect(await listMessages(request)).toHaveLength(1);
});
test('a confirmed email in another browser restarts from registered app state', async ({
    page,
    request,
    browser,
    context,
}) => {
    await page.goto(first + '/reports');
    await page.getByLabel('Email', { exact: true }).fill('owner@example.com');
    await page.getByRole('button', { name: /send|sign in/i }).click();
    const link = await waitForMagicLink(request, {
        recipient: 'owner@example.com',
        callbackUrlPrefix: issuer + '/sso/verify',
    });
    const other = await browser.newContext({
        ignoreHTTPSErrors: true,
        proxy: { server: 'http://127.0.0.1:45100' },
    });
    try {
        const tab = await other.newPage();
        await tab.goto(link);
        expect(
            (await other.cookies(issuer)).some(
                (cookie) => cookie.name === '__Host-magic-sso-browser',
            ),
        ).toBe(false);
        await tab.getByRole('button', { name: /continue|confirm/i }).click();
        await expect(tab.getByRole('link', { name: 'Continue to application' })).toBeVisible();
        expect((await other.cookies(first)).some((cookie) => cookie.name === 'magic-sso')).toBe(
            false,
        );
        await tab.getByRole('link', { name: 'Continue to application' }).click();
        await tab.goto(first + '/reports');
        await expect(tab.getByTestId('email')).toHaveText('owner@example.com');
        expect((await context.cookies(first)).some((cookie) => cookie.name === 'magic-sso')).toBe(
            false,
        );
        expect(await listMessages(request)).toHaveLength(1);
    } finally {
        await other.close();
    }
});
test('two sign-in tabs retain their own transaction and OTP context', async ({
    page,
    context,
    request,
}) => {
    const other = await context.newPage();
    await page.goto(first + '/reports?tab=first');
    await other.goto(first + '/reports?tab=second');
    await page.getByLabel('Email', { exact: true }).fill('owner@example.com');
    await page.getByRole('button', { name: /send|sign in/i }).click();
    const code = await waitForEmailOtp(request, { recipient: 'owner@example.com' });
    await other.getByLabel('Email', { exact: true }).fill('other@example.com');
    await other.getByRole('button', { name: /send|sign in/i }).click();
    const otherCode = await waitForEmailOtp(request, { recipient: 'other@example.com' });
    expect(
        (await context.cookies(first)).filter((cookie) => cookie.name.includes('magic-sso-tx-')),
    ).toHaveLength(2);
    await page.getByLabel(/one-time code/i).fill(code);
    await page.getByRole('button', { name: /code/i }).click();
    await expect(page).toHaveURL(first + '/reports?tab=first');
    expect(
        (await context.cookies(first)).filter((cookie) => cookie.name.includes('magic-sso-tx-')),
    ).toHaveLength(1);
    await other.getByLabel(/one-time code/i).fill(otherCode);
    await other.getByRole('button', { name: /code/i }).click();
    await expect(other).toHaveURL(first + '/reports?tab=second');
    expect(
        (await context.cookies(first)).filter((cookie) => cookie.name.includes('magic-sso-tx-')),
    ).toHaveLength(0);
    await other.close();
});
test('lost exchange response is not retried and a copied callback cannot replace a valid app session', async ({
    page,
    request,
}) => {
    await loginFirst(page, request);
    const before = await metrics(request);
    await request.post(issuer + '/test/drop-exchange');
    await page.goto(second + '/protected');
    await expect(
        page.getByRole('heading', { name: 'Sign-in could not be completed' }),
    ).toBeVisible();
    expect(await metrics(request)).toBe(before + 1);
    expect(await listMessages(request)).toHaveLength(1);
    let callback = '';
    page.on('request', (entry) => {
        if (entry.url().startsWith(second + '/sso/callback?')) {
            callback = entry.url();
        }
    });
    await page.getByRole('link', { name: 'Return to application' }).click();
    await expect(page.getByText('owner@example.com', { exact: true })).toBeVisible();
    await page.goto(callback);
    await expect(
        page.getByRole('heading', { name: 'Sign-in could not be completed' }),
    ).toBeVisible();
    expect(await metrics(request)).toBe(before + 2);
    await page.goto(second + '/protected');
    await expect(page.getByText('owner@example.com', { exact: true })).toBeVisible();
});

test('the browser blocks a third-party cookie but accepts it during a top-level visit', async ({
    page,
    context,
}) => {
    await page.route(first + '/privacy-check', async (route) => {
        await route.fulfill({
            contentType: 'text/html',
            body: `<iframe src="${issuer}/test/cookie-probe"></iframe>`,
        });
    });
    const response = page.waitForResponse(issuer + '/test/cookie-probe');
    await page.goto(first + '/privacy-check');
    await response;
    expect(
        (await context.cookies(issuer)).some(
            (cookie) => cookie.name === 'browser-sso-third-party-probe',
        ),
    ).toBe(false);
    await page.goto(issuer + '/test/cookie-probe');
    expect(
        (await context.cookies(issuer)).some(
            (cookie) => cookie.name === 'browser-sso-third-party-probe',
        ),
    ).toBe(true);
});

for (const mode of ['404', 'disabled']) {
    test(`auto mode completes legacy sign-in when discovery reports ${mode}`, async ({
        page,
        request,
        context,
    }) => {
        const origin = browserSsoOrigin('compat');
        const configured = await request.post(issuer + '/test/compatibility', { data: { mode } });
        expect(configured.ok()).toBe(true);
        try {
            await page.goto(origin + '/reports');
            await expect(page).toHaveURL(
                (url) => url.origin === issuer && url.pathname === '/signin',
            );
            expect(
                (await context.cookies(origin)).some((cookie) =>
                    cookie.name.includes('magic-sso-tx-'),
                ),
            ).toBe(false);
            await page.getByLabel('Email', { exact: true }).fill('owner@example.com');
            await page.getByRole('button', { name: /send|sign in/i }).click();
            const link = await waitForMagicLink(request, {
                recipient: 'owner@example.com',
                callbackUrlPrefix: origin + '/_magicgate/verify-email',
            });
            await page.goto(link);
            await page.getByRole('button', { name: /continue|confirm/i }).click();
            await expect(page.getByTestId('email')).toHaveText('owner@example.com');
            expect(
                (await context.cookies(issuer)).some(
                    (cookie) => cookie.name === '__Host-magic-sso-browser',
                ),
            ).toBe(false);
            expect(await listMessages(request)).toHaveLength(1);
        } finally {
            await request.post(issuer + '/test/compatibility', { data: { mode: 'normal' } });
        }
    });
}
