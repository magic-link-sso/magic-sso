import { expect, test, type APIRequestContext, type Page } from '@playwright/test';
import { clearMailbox, waitForMagicLink } from './helpers/mail-sink.js';
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

test('manager admin can grant scoped access and the user can sign in immediately after apply', async ({
    browser,
    page,
    request,
}) => {
    await clearMailbox(request);
    await signInToManager(page, request);

    await page.goto(`${managerOrigin}/sites/photos`);
    await expect(page.getByRole('heading', { exact: true, name: 'photos' })).toBeVisible();
    await expect(page.getByRole('heading', { name: 'People with access' })).toBeVisible();

    const addPersonComposer = page.locator('details[data-editor-kind="new"]');
    await addPersonComposer.locator('summary').click();
    await addPersonComposer.getByLabel('Email').fill(scopedUserEmail);
    await addPersonComposer.getByLabel('Access level').selectOption('scoped');
    await addPersonComposer.getByLabel(scopedAccess).check();
    await addPersonComposer.getByRole('button', { name: 'Save access' }).click();

    await expect(page).toHaveURL(/\/sites\/photos/u);
    await expect(page.locator(`details[data-grant-email="${scopedUserEmail}"]`)).toBeVisible();
    await expect(page.getByText(`Saved access for ${scopedUserEmail}.`)).toBeVisible();

    await page.goto(`${managerOrigin}/diff`);
    await expect(page.getByRole('heading', { name: 'Runtime Diff' })).toBeVisible();
    await expect(page.getByText(`${scopedUserEmail} [${scopedAccess}]`)).toBeVisible();
    await page.getByRole('button', { name: 'Publish changes' }).click();
    await expect(page.getByText('Applied runtime config and reloaded the server.')).toBeVisible();
    await expect(page.getByText('No managed access changes are pending right now.')).toBeVisible();

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
    } finally {
        await userContext.close();
    }

    await page.goto(`${managerOrigin}/`);
    await expect(page).toHaveURL(`${managerOrigin}/`);
    await expect(page.getByRole('heading', { name: 'Operations Dashboard' })).toBeVisible();
});
