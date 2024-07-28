import { expect, type APIRequestContext, type Page } from '@playwright/test';
import type { Cookie } from '@playwright/test';
import type { ExampleAppDefinition } from './apps.js';
import { waitForMagicLink } from './mail-sink.js';

export type FlowMode = 'direct' | 'indirect';

const hostedAuthOrigin = 'http://localhost:43100';

export async function requestMagicLink(
    page: Page,
    request: APIRequestContext,
    app: ExampleAppDefinition,
    email: string,
    protectedPath: string,
    flowMode: FlowMode,
): Promise<string> {
    await openSignInEntry(page, app, protectedPath, flowMode);
    await page.getByLabel('Email').fill(email);
    await page.getByRole('button', { name: 'Send magic link' }).click();

    await expectSubmissionFeedback(page);

    return waitForMagicLink(request, {
        callbackUrlPrefix: `${app.appUrl}${app.verifyPath}`,
        recipient: email,
    });
}

export async function expectAuthCookie(page: Page, app: ExampleAppDefinition): Promise<Cookie> {
    const cookies = await page.context().cookies(app.appUrl);
    const authCookie = cookies.find((cookie) => cookie.name === 'magic-sso');

    expect(authCookie).toBeDefined();
    expect(authCookie?.httpOnly).toBe(true);
    expect(authCookie?.sameSite).toBe('Lax');

    if (typeof authCookie === 'undefined') {
        throw new Error(`Expected a magic-sso cookie for ${app.displayName}.`);
    }

    return authCookie;
}

export async function expectNoAuthCookie(page: Page, app: ExampleAppDefinition): Promise<void> {
    const cookies = await page.context().cookies(app.appUrl);
    const authCookie = cookies.find((cookie) => cookie.name === 'magic-sso');

    expect(authCookie).toBeUndefined();
}

export async function completeMagicLinkSignIn(page: Page, email: string): Promise<void> {
    const continueButton = page.getByRole('button', { name: 'Continue' });

    try {
        await expect(continueButton).toBeVisible({ timeout: 1_000 });
    } catch {
        return;
    }

    await expect(page.locator('#email-value')).toContainText(email);
    await continueButton.click();
}

export async function openSignInEntry(
    page: Page,
    app: ExampleAppDefinition,
    protectedPath: string,
    flowMode: FlowMode,
): Promise<void> {
    const protectedUrl = `${app.appUrl}${protectedPath}`;

    await page.goto(protectedUrl);
    if (flowMode === 'indirect') {
        await app.expectLoginPage(page, protectedUrl);
        return;
    }

    await expectHostedSignInPage(page, app, protectedUrl);
}

export async function expectSubmissionFeedback(page: Page): Promise<void> {
    const hostedConfirmationHeading = page.getByRole('heading', { name: 'Check your email' });
    try {
        await expect(hostedConfirmationHeading).toBeVisible({ timeout: 1_000 });
        return;
    } catch {
        // Fall through to the app-local confirmation UI.
    }

    await expect(page.getByRole('status')).toContainText(
        /Verification email sent|Email sent, check your inbox/u,
    );
}

export async function expectHostedSignInPage(
    page: Page,
    app: ExampleAppDefinition,
    expectedReturnUrl: string,
): Promise<void> {
    await expect(page.getByRole('heading', { name: 'Sign in' })).toBeVisible();
    await expect(page).toHaveURL(/\/signin\?/u);

    const currentUrl = new URL(page.url());
    expect(currentUrl.origin).toBe(hostedAuthOrigin);
    expect(currentUrl.pathname).toBe('/signin');
    expect(currentUrl.searchParams.get('returnUrl')).toBe(expectedReturnUrl);
    expect(currentUrl.searchParams.get('verifyUrl')).toBe(
        `${app.appUrl}${app.verifyPath}?returnUrl=${encodeURIComponent(expectedReturnUrl)}`,
    );
}
