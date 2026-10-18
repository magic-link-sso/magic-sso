// SPDX-License-Identifier: MIT
import { test as base, expect } from '@playwright/test';
import { browserSsoHttps, browserSsoOrigin } from '../../src/browser-sso-fixture.js';
export { expect };
export const test = base.extend<{ ssoPrivacy: void }>({
    ssoPrivacy: [
        async ({ page, context, browserName }, use): Promise<void> => {
            if (browserSsoHttps && browserName === 'chromium') {
                const cdp = await context.newCDPSession(page);
                await cdp.send('Network.enable');
                await cdp.send('Network.setCookieControls', {
                    enableThirdPartyCookieRestriction: true,
                });
            }
            const violations: string[] = [];
            page.on('request', (request) => {
                const url = new URL(request.url());
                if (
                    url.origin === browserSsoOrigin('issuer') &&
                    url.pathname.startsWith('/sso/') &&
                    (!request.isNavigationRequest() || request.frame() !== page.mainFrame())
                ) {
                    violations.push(`${request.method()} ${url.pathname}`);
                }
            });
            await use();
            expect(violations).toEqual([]);
        },
        { auto: true },
    ],
});
