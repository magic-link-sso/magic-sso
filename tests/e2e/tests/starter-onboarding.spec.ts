import { expect, test } from '@playwright/test';
import {
    clearMailbox,
    expectNoMessagesForRecipient,
    waitForMagicLink,
} from './helpers/mail-sink.js';
import { completeMagicLinkSignIn, expectSubmissionFeedback } from './helpers/magic-link-flow.js';

const gate = process.env.MAGICSSO_STARTER_PATH === 'gate';
const appOrigin = gate ? 'http://localhost:43106' : 'http://localhost:43101';
const protectedUrl = `${appOrigin}${gate ? '/' : '/private'}?filter=pending&page=2`;
const callback = `${appOrigin}${gate ? '/_magicgate/verify-email' : '/verify-email'}`;

test('generated starter supports first login, a second allowed person, logout, and denial', async ({
    page,
    request,
    browser,
}) => {
    await clearMailbox(request);
    await page.goto(protectedUrl);
    await expect(page.getByRole('heading', { name: 'Sign in', exact: true })).toBeVisible();
    await page.getByLabel('Email').fill('owner@example.com');
    await page.getByRole('button', { name: 'Send magic link' }).click();
    await expectSubmissionFeedback(page);
    const magicLink = await waitForMagicLink(request, {
        callbackUrlPrefix: callback,
        recipient: 'owner@example.com',
    });
    await page.goto(magicLink);
    await completeMagicLinkSignIn(page, 'owner@example.com');
    await expect(page).toHaveURL(protectedUrl);
    await expect(
        page.getByRole('heading', {
            name: gate ? 'Your private application' : 'You are signed in',
        }),
    ).toBeVisible();
    await page.reload();
    await expect(page).toHaveURL(protectedUrl);
    await page.getByRole('button', { name: 'Sign out' }).click();
    await page.goto(protectedUrl);
    await expect(page.getByRole('heading', { name: 'Sign in', exact: true })).toBeVisible();

    const second = await browser.newContext();
    try {
        await clearMailbox(request);
        const friend = await second.newPage();
        await friend.goto(protectedUrl);
        await friend.getByLabel('Email').fill('friend@example.com');
        await friend.getByRole('button', { name: 'Send magic link' }).click();
        await expectSubmissionFeedback(friend);
        await friend.goto(
            await waitForMagicLink(request, {
                callbackUrlPrefix: callback,
                recipient: 'friend@example.com',
            }),
        );
        await completeMagicLinkSignIn(friend, 'friend@example.com');
        await expect(friend).toHaveURL(protectedUrl);
    } finally {
        await second.close();
    }
    await clearMailbox(request);
    await page.getByLabel('Email').fill('outsider@example.com');
    await page.getByRole('button', { name: 'Send magic link' }).click();
    await expectNoMessagesForRecipient(request, 'outsider@example.com');
    await page.goto(protectedUrl);
    await expect(page.getByRole('heading', { name: 'Sign in', exact: true })).toBeVisible();
});
