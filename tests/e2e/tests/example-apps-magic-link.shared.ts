import { expect, test, type Page } from '@playwright/test';
import { exampleApps, type ExampleAppDefinition } from './helpers/apps.js';
import { clearMailbox, expectNoMessagesForRecipient } from './helpers/mail-sink.js';
import {
    completeMagicLinkSignIn,
    expectAuthCookie,
    expectHostedSignInPage,
    expectNoAuthCookie,
    expectSubmissionFeedback,
    openSignInEntry,
    requestMagicLink,
    type FlowMode,
} from './helpers/magic-link-flow.js';

export function registerMagicLinkSuites(flowMode: FlowMode): void {
    test.beforeEach(async ({ request }) => {
        await clearMailbox(request);
    });

    for (const app of exampleApps) {
        test.describe(`${app.displayName} example app (${flowMode})`, () => {
            for (const protectedPath of app.protectedPaths) {
                test(`signs in through ${protectedPath}`, async ({ page, request }) => {
                    const magicLink = await requestMagicLink(
                        page,
                        request,
                        app,
                        app.allowedEmail,
                        protectedPath,
                        flowMode,
                    );

                    await page.goto(magicLink);
                    await completeMagicLinkSignIn(page, app.allowedEmail);

                    const authCookie = await expectAuthCookie(page, app);
                    await app.expectAuthenticated(page, app.allowedEmail, protectedPath);
                    expect(authCookie.value.length).toBeGreaterThan(0);
                });

                test(`rejects tampered tokens for ${protectedPath}`, async ({ page, request }) => {
                    const magicLink = await requestMagicLink(
                        page,
                        request,
                        app,
                        app.allowedEmail,
                        protectedPath,
                        flowMode,
                    );
                    const tamperedLink = buildTamperedMagicLink(magicLink);

                    await page.goto(tamperedLink);

                    await expectTamperedTokenResult(page, app, `${app.appUrl}${protectedPath}`);
                    await expectNoAuthCookie(page, app);

                    const protectedUrl = `${app.appUrl}${protectedPath}`;
                    await page.goto(protectedUrl);
                    await expectSignInPrompt(page, app, protectedUrl);
                });

                if (app.name === 'nextjs') {
                    test(`logs out cleanly from ${protectedPath}`, async ({ page, request }) => {
                        const magicLink = await requestMagicLink(
                            page,
                            request,
                            app,
                            app.allowedEmail,
                            protectedPath,
                            flowMode,
                        );

                        await page.goto(magicLink);
                        await completeMagicLinkSignIn(page, app.allowedEmail);
                        await app.expectAuthenticated(page, app.allowedEmail, protectedPath);

                        await page.getByRole('button', { name: 'Logout' }).click();
                        await expectNoAuthCookie(page, app);

                        const protectedUrl = `${app.appUrl}${protectedPath}`;
                        await page.goto(protectedUrl);
                        await expectSignInPrompt(page, app, protectedUrl);
                    });
                }

                if (app.name === 'private1' || app.name === 'private2') {
                    test(`rejects replayed gate cookies after logout from ${protectedPath}`, async ({
                        page,
                        request,
                    }) => {
                        const magicLink = await requestMagicLink(
                            page,
                            request,
                            app,
                            app.allowedEmail,
                            protectedPath,
                            flowMode,
                        );

                        await page.goto(magicLink);
                        await completeMagicLinkSignIn(page, app.allowedEmail);

                        const authCookie = await expectAuthCookie(page, app);
                        await app.expectAuthenticated(page, app.allowedEmail, protectedPath);

                        await page.getByRole('button', { name: 'Logout' }).click();
                        await expectNoAuthCookie(page, app);

                        await page.context().addCookies([
                            {
                                domain: authCookie.domain,
                                httpOnly: authCookie.httpOnly,
                                name: authCookie.name,
                                path: authCookie.path,
                                sameSite: authCookie.sameSite,
                                secure: authCookie.secure,
                                value: authCookie.value,
                            },
                        ]);

                        const protectedUrl = `${app.appUrl}${protectedPath}`;
                        await page.goto(protectedUrl);

                        if (flowMode === 'indirect') {
                            await app.expectLoginPage(page, protectedUrl);
                            return;
                        }

                        await expectHostedSignInPage(page, app, protectedUrl);
                    });
                }
            }

            if (flowMode === 'indirect') {
                test('requires an email address before submitting the login form', async ({
                    page,
                }) => {
                    await openSignInEntry(page, app, app.protectedPaths[0] ?? '/', flowMode);

                    const signinRequest = page.waitForRequest(
                        (request) =>
                            request.method() === 'POST' && request.url().endsWith('/api/signin'),
                        {
                            timeout: 750,
                        },
                    );

                    await page.getByRole('button', { name: 'Send magic link' }).click();

                    await expect(signinRequest).rejects.toThrow();
                });
            }

            test('does not send a magic link for blocked email addresses', async ({
                page,
                request,
            }) => {
                await openSignInEntry(page, app, app.protectedPaths[0] ?? '/', flowMode);
                await page.getByLabel('Email').fill(app.blockedEmail);
                await page.getByRole('button', { name: 'Send magic link' }).click();

                await expectSubmissionFeedback(page);
                await expectNoMessagesForRecipient(request, app.blockedEmail);
            });
        });
    }
}

function buildTamperedMagicLink(magicLink: string): string {
    const tamperedLink = new URL(magicLink);
    const token = tamperedLink.searchParams.get('token');

    if (typeof token !== 'string' || token.length === 0) {
        throw new Error('Expected magic link to include a token.');
    }

    tamperedLink.searchParams.set('token', `${token}tampered`);
    return tamperedLink.toString();
}

async function expectTamperedTokenResult(
    page: Page,
    app: ExampleAppDefinition,
    expectedReturnUrl: string,
): Promise<void> {
    await expectSignInPrompt(page, app, expectedReturnUrl);
}

async function expectSignInPrompt(
    page: Page,
    app: ExampleAppDefinition,
    expectedReturnUrl: string,
): Promise<void> {
    const currentUrl = new URL(page.url());
    if (currentUrl.origin === 'http://localhost:43100' && currentUrl.pathname === '/signin') {
        await expectHostedSignInPage(page, app, expectedReturnUrl);
        return;
    }

    await expect(page.getByRole('heading', { name: app.loginHeading })).toBeVisible();
    expect(currentUrl.searchParams.get('returnUrl')).toBe(expectedReturnUrl);
}
