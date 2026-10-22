import { expect, test, type APIRequestContext, type Page } from '@playwright/test';
import {
    clearMailbox,
    expectNoMessagesForRecipient,
    waitForMagicLink,
} from './helpers/mail-sink.js';
import { completeMagicLinkSignIn, expectSubmissionFeedback } from './helpers/magic-link-flow.js';

const photosOrigin = 'http://localhost:5001';
const lockedPhotoUrl = `${photosOrigin}/photos/red-kite-at-dusk`;
const managerOrigin = 'http://localhost:43111';
const managerAdminEmail = 'manager@example.com';
const scopedUserEmail = 'collector@example.com';
const scopedAccess = 'photo:red-kite-at-dusk';

async function signInToManager(page: Page, request: APIRequestContext): Promise<void> {
    await page.goto(`${managerOrigin}/`);
    await expect(page.getByRole('heading', { name: 'Sign in' })).toBeVisible();
    await page.getByLabel('Email').fill(managerAdminEmail);
    await page.getByRole('button', { name: 'Send magic link' }).click();

    const magicLink = await waitForMagicLink(request, {
        callbackUrlPrefix: `${managerOrigin}/_magicgate/verify-email`,
        recipient: managerAdminEmail,
    });

    await page.goto(magicLink);
    await completeMagicLinkSignIn(page, managerAdminEmail);
    await expect(page).toHaveURL(`${managerOrigin}/`);
    await expect(page.getByRole('heading', { name: 'Operations Dashboard' })).toBeVisible();
}

test('manager admin can preview access across applications, publish and remove it while existing sessions expire normally', async ({
    browser,
    page,
    request,
}) => {
    await clearMailbox(request);
    await signInToManager(page, request);

    await page.getByRole('link', { name: 'People', exact: true }).click();
    await page.getByLabel('Email', { exact: true }).fill(scopedUserEmail);
    await page.getByRole('button', { name: 'Review person' }).click();
    await expect(page.getByRole('heading', { exact: true, name: scopedUserEmail })).toBeVisible();
    await page.getByLabel('Change access for photos', { exact: true }).selectOption('scoped');
    await page
        .getByRole('group', { name: 'Permissions for photos' })
        .getByLabel(scopedAccess, { exact: true })
        .check();
    await page.getByLabel('Change access for archive', { exact: true }).selectOption('full');
    await expect(page.getByText('Operator-owned access.', { exact: false })).toBeVisible();
    await page.getByRole('button', { name: 'Preview access changes' }).click();
    await expect(page.getByRole('heading', { name: 'Changes to save' })).toBeVisible();
    await expect(page.getByText(`After saving: ${scopedAccess}`, { exact: true })).toBeVisible();
    await expect(page.getByText('After saving: Full access (*)', { exact: true })).toBeVisible();
    await page.getByRole('button', { name: 'Save pending changes' }).click();
    await expect(
        page.getByText('Saved pending changes. Review all pending changes before publishing.', {
            exact: true,
        }),
    ).toBeVisible();

    await page.goto(`${managerOrigin}/diff`);
    await expect(page.getByRole('heading', { name: 'Runtime Diff' })).toBeVisible();
    await expect(page.getByText(`${scopedUserEmail} [${scopedAccess}]`)).toBeVisible();
    await page.getByRole('button', { name: 'Publish changes' }).click();
    await expect(page.getByText('Applied runtime config and reloaded the server.')).toBeVisible();
    await expect(page.getByText('No managed access changes are pending right now.')).toBeVisible();

    await page.goto(`${managerOrigin}/people/${scopedUserEmail}`);
    await expect(page.getByText('Last confirmed active at', { exact: false })).toBeVisible();
    await page.screenshot({ path: test.info().outputPath('people-desktop.png'), fullPage: true });
    await page.setViewportSize({ width: 390, height: 844 });
    await expect(page.getByRole('button', { name: 'Preview access changes' })).toBeVisible();
    expect(
        await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth),
    ).toBe(true);
    await page.screenshot({ path: test.info().outputPath('people-mobile.png'), fullPage: true });
    await page.setViewportSize({ width: 1280, height: 900 });

    await clearMailbox(request);

    const userContext = await browser.newContext();
    try {
        const userPage = await userContext.newPage();
        await userPage.goto(lockedPhotoUrl);
        await expect(
            userPage.getByRole('heading', {
                name: 'Red Kite at Dusk needs the dedicated photo scope.',
            }),
        ).toBeVisible();
        await userPage.getByRole('link', { name: 'Request access with Magic Link' }).click();
        await userPage.getByLabel('Email').fill(scopedUserEmail);
        await userPage.getByRole('button', { name: 'Send magic link' }).click();
        await expectSubmissionFeedback(userPage);

        const userMagicLink = await waitForMagicLink(request, {
            callbackUrlPrefix: `${photosOrigin}/verify-email`,
            recipient: scopedUserEmail,
        });

        await userPage.goto(userMagicLink);
        await completeMagicLinkSignIn(userPage, scopedUserEmail);
        await expect(userPage).toHaveURL(lockedPhotoUrl);
        await expect(
            userPage.getByRole('heading', {
                exact: true,
                level: 1,
                name: 'Red Kite at Dusk',
            }),
        ).toBeVisible();
        await expect(userPage.getByText(scopedUserEmail)).toBeVisible();
        await expect(
            userPage.getByText('This piece demonstrates a photo-specific scope'),
        ).toBeVisible();

        await page.goto(`${managerOrigin}/people/${scopedUserEmail}`);
        await page.getByLabel('Change access for photos', { exact: true }).selectOption('remove');
        await page.getByLabel('Change access for archive', { exact: true }).selectOption('remove');
        await page.getByRole('button', { name: 'Preview access changes' }).click();
        await expect(page.getByText('After saving: No access', { exact: true })).toHaveCount(2);
        await page.getByRole('button', { name: 'Save pending changes' }).click();
        await page.goto(`${managerOrigin}/diff`);
        await page.getByRole('button', { name: 'Publish changes' }).click();
        await expect(
            page.getByText('Applied runtime config and reloaded the server.'),
        ).toBeVisible();
        await page.goto(`${managerOrigin}/people/${scopedUserEmail}`);
        for (const site of ['photos', 'archive']) {
            const section = page.getByRole('region', { name: `${site} access`, exact: true });
            await expect(section.getByText('No access', { exact: true })).toHaveCount(3);
        }
        // Applications retain already-issued sessions until expiry or local sign-out.
        await userPage.reload();
        await expect(
            userPage.getByRole('heading', { name: 'Red Kite at Dusk', exact: true, level: 1 }),
        ).toBeVisible();
        await clearMailbox(request);
        await userContext.clearCookies();
        await userPage.goto(lockedPhotoUrl);
        await userPage.getByRole('link', { name: 'Request access with Magic Link' }).click();
        await userPage.getByLabel('Email').fill(scopedUserEmail);
        await userPage.getByRole('button', { name: 'Send magic link' }).click();
        await expectSubmissionFeedback(userPage);
        await expectNoMessagesForRecipient(request, scopedUserEmail);
    } finally {
        await userContext.close();
    }

    await page.goto(`${managerOrigin}/`);
    await expect(page).toHaveURL(`${managerOrigin}/`);
    await expect(page.getByRole('heading', { name: 'Operations Dashboard' })).toBeVisible();
});
