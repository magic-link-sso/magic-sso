// SPDX-License-Identifier: MIT

import { expect, test, type APIRequestContext, type Page } from '@playwright/test';
import { verifyAuthToken } from '../../../../packages/core/src/token.js';
import {
    runSignInFlowContract,
    signInReturnPaths,
    type SignInFlowDriver,
    type SignInFlowScenario,
} from '../../../../packages/core/test/sign-in-contract.js';
import { exampleApps, type ExampleAppDefinition } from './apps.js';
import {
    completeMagicLinkSignIn,
    createInvalidOtp,
    expectAuthCookie,
    expectNoAuthCookie,
    openSignInEntry,
    requestEmailOtp,
    requestMagicLink,
    submitEmailOtp,
    type FlowMode,
} from './magic-link-flow.js';

function createDriver(
    page: Page,
    request: APIRequestContext,
    app: ExampleAppDefinition,
    mode: FlowMode,
): SignInFlowDriver {
    return {
        requestVerification: (method, path) =>
            method === 'magic-link'
                ? requestMagicLink(page, request, app, app.allowedEmail, path, mode)
                : requestEmailOtp(page, request, app, app.allowedEmail, path, mode),
        hasSession: async () =>
            (await page.context().cookies(app.appUrl)).some(
                (cookie) => cookie.name === 'magic-sso',
            ),
        async verify(method, credential) {
            if (method === 'magic-link') {
                await page.goto(credential);
            } else {
                await submitEmailOtp(page, createInvalidOtp(credential));
                await expect(page.getByRole('main').getByRole('alert')).toBeVisible();
                await expectNoAuthCookie(page, app);
                await submitEmailOtp(page, credential);
            }
            await completeMagicLinkSignIn(page, app.allowedEmail);
        },
        async readSession(path) {
            await app.expectAuthenticated(page, app.allowedEmail, path);
            const cookie = await expectAuthCookie(page, app);
            const payload = await verifyAuthToken(
                cookie.value,
                new TextEncoder().encode('test-jwt-secret-for-e2e-suite-123456'),
                {
                    expectedAudience: app.appUrl,
                    expectedIssuer: 'http://localhost:43100',
                },
            );
            if (!payload) {
                throw new Error(`Invalid signed application session for ${app.displayName}`);
            }
            return {
                url: page.url(),
                email: payload.email,
                siteId: payload.siteId,
                jti: payload.jti,
                httpOnly: cookie.httpOnly,
                sameSite: cookie.sameSite,
            };
        },
        async revisit(path) {
            await page.goto(`${app.appUrl}${path}`);
        },
        async logout() {
            await page.getByRole('button', { name: 'Logout' }).click();
        },
        expectSignInRequired: (path) => openSignInEntry(page, app, path, mode),
    };
}

export function registerSignInFlowSuites(
    mode: FlowMode,
    method: SignInFlowScenario['method'],
    apps: readonly ExampleAppDefinition[] = exampleApps,
): void {
    for (const app of apps) {
        test.describe(`${app.displayName} ${method} flow contract (${mode})`, () => {
            if (app.name === 'nextjs' && method === 'otp') {
                test.beforeEach(async ({ page }) => {
                    await page.addInitScript(() => {
                        document.addEventListener('DOMContentLoaded', () => {
                            // Next.js can render an empty route-announcement alert after hydration.
                            const announcer = document.createElement('div');
                            announcer.setAttribute('role', 'alert');
                            document.body.append(announcer);
                        });
                    });
                });
            }
            for (const protectedPath of app.protectedPaths.flatMap(signInReturnPaths)) {
                test(`establishes, reuses and clears the session for ${protectedPath}`, async ({
                    page,
                    request,
                }) => {
                    await runSignInFlowContract(createDriver(page, request, app, mode), {
                        method,
                        appOrigin: app.appUrl,
                        email: app.allowedEmail,
                        siteId: app.name,
                        returnPath: protectedPath,
                    });
                });
            }
        });
    }
}
