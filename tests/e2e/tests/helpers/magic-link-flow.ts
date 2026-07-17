import { expect, type APIRequestContext, type Page } from '@playwright/test';
import type { Cookie } from '@playwright/test';
import type { ExampleAppDefinition } from './apps.js';
import { waitForEmailOtp, waitForMagicLink } from './mail-sink.js';

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

export async function requestEmailOtp(
    page: Page,
    request: APIRequestContext,
    app: ExampleAppDefinition,
    email: string,
    protectedPath: string,
    flowMode: FlowMode,
): Promise<string> {
    await openSignInEntry(page, app, protectedPath, flowMode);

    return submitEmailOtpRequest(page, request, email);
}

async function submitEmailOtpRequest(
    page: Page,
    request: APIRequestContext,
    email: string,
): Promise<string> {
    const useDifferentEmailControl = page
        .getByRole('link', { name: 'Use a different email' })
        .or(page.getByRole('button', { name: 'Use a different email' }));
    if (await useDifferentEmailControl.isVisible()) {
        await useDifferentEmailControl.click();
    }

    await page.getByLabel('Email').fill(email);
    await page.getByRole('button', { name: 'Send magic link' }).click();

    await expectSubmissionFeedback(page);
    const codeField = page.getByLabel('One-time code');
    await expect(codeField).toHaveCount(1);
    await expect(codeField).toBeVisible();

    return waitForEmailOtp(request, { recipient: email });
}

export function createInvalidOtp(code: string): string {
    const firstDigit = Number.parseInt(code.slice(0, 1), 10);
    if (!Number.isInteger(firstDigit)) {
        throw new Error('Expected OTP to begin with an ASCII digit.');
    }

    return `${(firstDigit + 1) % 10}${code.slice(1)}`;
}

export async function submitEmailOtp(page: Page, code: string): Promise<void> {
    await page.getByLabel('One-time code').fill(code);
    await page.getByRole('button', { name: 'Sign in with code' }).click();
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
    await expect(page.getByRole('heading', { name: 'Check your email' })).toBeVisible();
    await expect(
        page.getByText('If your email can sign in, you will receive a link shortly.'),
    ).toBeVisible();
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
