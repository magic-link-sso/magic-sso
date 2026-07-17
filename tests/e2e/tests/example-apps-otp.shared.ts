import { expect, test } from '@playwright/test';
import { exampleApps } from './helpers/apps.js';
import { clearMailbox } from './helpers/mail-sink.js';
import {
    completeMagicLinkSignIn,
    createInvalidOtp,
    expectAuthCookie,
    expectNoAuthCookie,
    requestEmailOtp,
    submitEmailOtp,
    type FlowMode,
} from './helpers/magic-link-flow.js';

export function registerEmailOtpSuites(flowMode: FlowMode): void {
    test.beforeEach(async ({ request }) => {
        await clearMailbox(request);
    });

    for (const app of exampleApps) {
        test.describe(`${app.displayName} example app OTP (${flowMode})`, () => {
            for (const protectedPath of app.protectedPaths) {
                test(`rejects an invalid code and accepts a retry through ${protectedPath}`, async ({
                    page,
                    request,
                }) => {
                    const code = await requestEmailOtp(
                        page,
                        request,
                        app,
                        app.allowedEmail,
                        protectedPath,
                        flowMode,
                    );

                    await submitEmailOtp(page, createInvalidOtp(code));
                    await expect(page.getByRole('alert')).toBeVisible();
                    await expectNoAuthCookie(page, app);

                    await submitEmailOtp(page, code);
                    if (flowMode === 'direct') {
                        await completeMagicLinkSignIn(page, app.allowedEmail);
                    }

                    await app.expectAuthenticated(page, app.allowedEmail, protectedPath);
                    const authCookie = await expectAuthCookie(page, app);
                    expect(authCookie.value.length).toBeGreaterThan(0);
                });
            }
        });
    }
}
