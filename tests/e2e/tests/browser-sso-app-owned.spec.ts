// SPDX-License-Identifier: MIT
import { test, expect } from './helpers/browser-sso-test.js';
import {
    browserSsoOrigin,
    browserSsoProxyUrl,
    type BrowserSsoFixtureRole,
} from '../src/browser-sso-fixture.js';
import {
    clearMailbox,
    listMessages,
    waitForMagicLink,
    waitForEmailOtp,
} from './helpers/mail-sink.js';
import { canonicalFlowUrl } from '../../../packages/core/test/sign-in-contract.js';
const issuer = browserSsoOrigin('issuer');
interface App {
    role: BrowserSsoFixtureRole;
    path: string;
    start: string;
}
const apps: App[] = [
    { role: 'gate-a', path: '/reports', start: '/_magicgate/sso/start' },
    { role: 'gate-b', path: '/private/reports', start: '/private/_access/sso/start' },
    { role: 'django', path: '/protected1', start: '/sso/start/' },
    ...(['next', 'angular', 'nuxt', 'fastify'] satisfies BrowserSsoFixtureRole[]).map((role) => ({
        role,
        path: '/protected',
        start: '/sso/start',
    })),
];
const query = '?q=a%2Bb%20%26%20c&tag=one&tag=two';
async function transientCookieNames(
    response: import('@playwright/test').Response | null,
): Promise<string[]> {
    if (!response) {
        throw new Error('Expected a document response for the cookie check.');
    }
    // Cookie metadata can retain expired entries; inspect what the browser actually sends.
    const header = (await response.request().headerValue('cookie')) ?? '';
    return header
        .split(';')
        .map((pair) => pair.trim().split('=', 1)[0] ?? '')
        .filter((name) => /magic-sso-(?:tx-|continuation-|confirm-)/u.test(name));
}

test('expired transaction cookies are not sent in requests', async ({ context, page }) => {
    const name = '__Host-magic-sso-tx-delayed-cleanup';
    await context.addCookies([
        {
            name,
            value: '',
            url: issuer,
            secure: true,
            httpOnly: true,
            sameSite: 'Lax',
            expires: Date.now() / 1000 + 2,
        },
    ]);
    expect(await transientCookieNames(await page.goto(issuer + '/test/cookie-probe'))).toEqual([
        name,
    ]);
    await expect.poll(async () => transientCookieNames(await page.reload())).toEqual([]);
});

async function requestAppSignIn(
    page: import('@playwright/test').Page,
    email = 'owner@example.com',
): Promise<void> {
    await page.getByLabel('Email address', { exact: true }).fill(email);
    await page.getByLabel('Email address', { exact: true }).press('Enter');
}

test('app-owned sign-in sends email when pointer activation of the send button is lost', async ({
    page,
    request,
}) => {
    await clearMailbox(request);
    await page.addInitScript(() => {
        document.addEventListener(
            'click',
            (event) => {
                if (
                    event.detail > 0 &&
                    event.target instanceof HTMLButtonElement &&
                    event.target.textContent === 'Send magic link'
                ) {
                    event.preventDefault();
                }
            },
            { capture: true },
        );
    });
    await page.goto(browserSsoOrigin('nuxt') + '/protected');
    await requestAppSignIn(page);
    await expect(page.getByRole('heading', { name: 'Check your email' })).toBeVisible();
    await waitForMagicLink(request, {
        recipient: 'owner@example.com',
        callbackUrlPrefix: browserSsoOrigin('nuxt') + '/sso/start',
    });
    expect(await listMessages(request)).toHaveLength(1);
});

async function waitForApplicationReady(
    page: import('@playwright/test').Page,
    role: BrowserSsoFixtureRole,
): Promise<void> {
    if (role !== 'nuxt') {
        return;
    }
    await page.waitForFunction(() => {
        const root = document.querySelector('#__nuxt');
        const app: unknown = root ? Reflect.get(root, '__vue_app__') : undefined;
        const nuxt: unknown =
            typeof app === 'object' && app !== null ? Reflect.get(app, '$nuxt') : undefined;
        return (
            typeof nuxt === 'object' && nuxt !== null && Reflect.get(nuxt, 'isHydrating') === false
        );
    });
}

for (const app of apps) {
    for (const method of ['link', 'otp']) {
        test(`${app.role} app-owned ${method} establishes local then shared sign-in and reuses it across the ring`, async ({
            page,
            context,
            request,
        }) => {
            await clearMailbox(request);
            const origin = browserSsoOrigin(app.role),
                destination = origin + app.path + query;
            await request.post(issuer + '/test/pause-bootstrap');
            await page.goto(destination);
            await expect(page.getByLabel('Email address', { exact: true })).toBeVisible();
            expect(new URL(page.url()).origin).toBe(origin);
            expect(new URL(page.url()).pathname).toBe(app.start);
            await requestAppSignIn(page);
            await expect(page.getByRole('heading', { name: 'Check your email' })).toBeVisible();
            if (method === 'link') {
                const link = await waitForMagicLink(request, {
                    recipient: 'owner@example.com',
                    callbackUrlPrefix: origin + app.start,
                });
                await page.goto(link);
                await expect(
                    page.getByText('Continue as owner@example.com.', { exact: false }),
                ).toBeVisible();
                await page.getByRole('button', { name: 'Continue', exact: true }).click();
            } else {
                const code = await waitForEmailOtp(request, { recipient: 'owner@example.com' });
                await page.getByLabel('Email code', { exact: true }).fill(code);
                await page.getByRole('button', { name: 'Verify code', exact: true }).click();
            }
            await expect(
                page.getByRole('heading', { name: 'Paused before shared session' }),
            ).toBeVisible();
            const beforeShared = await context.cookies();
            expect(
                beforeShared.find(
                    (cookie) =>
                        cookie.name === 'magic-sso' && cookie.domain === new URL(origin).hostname,
                )?.httpOnly,
            ).toBe(true);
            expect(beforeShared.some((cookie) => cookie.name === '__Host-magic-sso-browser')).toBe(
                false,
            );
            const applicationResponse = page.waitForResponse(
                (response) =>
                    response.request().isNavigationRequest() &&
                    canonicalFlowUrl(response.url()) === canonicalFlowUrl(destination),
            );
            await page.getByRole('link', { name: 'Complete shared sign-in', exact: true }).click();
            await expect(page).toHaveURL(
                (url) => canonicalFlowUrl(url.href) === canonicalFlowUrl(destination),
            );
            expect(await transientCookieNames(await applicationResponse)).toEqual([]);
            await waitForApplicationReady(page, app.role);
            const local = (await context.cookies(destination)).find(
                (cookie) => cookie.name === 'magic-sso',
            )?.value;
            expect(local).toBeTruthy();
            expect(
                (await context.cookies(issuer)).find(
                    (cookie) => cookie.name === '__Host-magic-sso-browser',
                )?.secure,
            ).toBe(true);
            for (const target of apps.filter((target) => target.role !== app.role)) {
                const url = browserSsoOrigin(target.role) + target.path + query;
                await page.goto(url);
                await expect(page).toHaveURL(
                    (value) => canonicalFlowUrl(value.href) === canonicalFlowUrl(url),
                );
                await waitForApplicationReady(page, target.role);
            }
            expect(
                (await context.cookies(destination)).find((cookie) => cookie.name === 'magic-sso')
                    ?.value,
            ).toBe(local);
            expect(await listMessages(request)).toHaveLength(1);
        });
    }
}

async function submitOtp(
    page: import('@playwright/test').Page,
    request: import('@playwright/test').APIRequestContext,
    email = 'owner@example.com',
): Promise<void> {
    await requestAppSignIn(page, email);
    await page
        .getByLabel('Email code', { exact: true })
        .fill(await waitForEmailOtp(request, { recipient: email }));
    await page.getByRole('button', { name: 'Verify code', exact: true }).click();
}
for (const app of apps.filter((app) => ['gate-b', 'next', 'django'].includes(app.role))) {
    test(`${app.role} finish never authenticates without its existing local JWT`, async ({
        page,
        context,
        request,
    }) => {
        await clearMailbox(request);
        await request.post(issuer + '/test/pause-bootstrap');
        const destination = browserSsoOrigin(app.role) + app.path;
        await page.goto(destination);
        await submitOtp(page, request);
        await expect(
            page.getByRole('heading', { name: 'Paused before shared session' }),
        ).toBeVisible();
        await context.clearCookies({ name: 'magic-sso' });
        await page.getByRole('link', { name: 'Complete shared sign-in', exact: true }).click();
        await expect(
            page.getByRole('heading', { name: 'Shared sign-in was not completed' }),
        ).toBeVisible();
        expect(
            (await context.cookies(destination)).some((cookie) => cookie.name === 'magic-sso'),
        ).toBe(false);
        expect(
            (await context.cookies(issuer)).some(
                (cookie) => cookie.name === '__Host-magic-sso-browser',
            ),
        ).toBe(true);
        expect(await listMessages(request)).toHaveLength(1);
    });
    test(`${app.role} retains a valid local JWT when the current grant denies bootstrap`, async ({
        page,
        context,
        request,
    }) => {
        await clearMailbox(request);
        await request.post(issuer + '/test/pause-bootstrap');
        const destination = browserSsoOrigin(app.role) + app.path + query;
        await page.goto(destination);
        await submitOtp(page, request);
        await expect(
            page.getByRole('heading', { name: 'Paused before shared session' }),
        ).toBeVisible();
        const local = (await context.cookies(destination)).find(
            (cookie) => cookie.name === 'magic-sso',
        )?.value;
        await request.post(issuer + '/test/grant', {
            data: { site: app.role, email: 'owner@example.com', allowed: false },
        });
        try {
            await page.getByRole('link', { name: 'Complete shared sign-in', exact: true }).click();
            await page.getByRole('link', { name: 'Return to application', exact: true }).click();
            await expect(
                page.getByRole('heading', { name: 'Shared sign-in was not completed' }),
            ).toBeVisible();
            expect(
                (await context.cookies(destination)).find((cookie) => cookie.name === 'magic-sso')
                    ?.value,
            ).toBe(local);
            expect(
                (await context.cookies(issuer)).some(
                    (cookie) => cookie.name === '__Host-magic-sso-browser',
                ),
            ).toBe(false);
            await page.getByRole('link', { name: 'Continue to application', exact: true }).click();
            await expect(page).toHaveURL(
                (url) => canonicalFlowUrl(url.href) === canonicalFlowUrl(destination),
            );
        } finally {
            await request.post(issuer + '/test/grant', {
                data: { site: app.role, email: 'owner@example.com', allowed: true },
            });
        }
    });
}
for (const role of ['next', 'django'] satisfies BrowserSsoFixtureRole[]) {
    test(`${role} email confirmed in another browser creates only a local session`, async ({
        page,
        browser,
        request,
        context,
    }) => {
        await clearMailbox(request);
        const origin = browserSsoOrigin(role),
            start = '/sso/start' + (role === 'django' ? '/' : '');
        await page.goto(origin + start);
        await requestAppSignIn(page);
        const link = await waitForMagicLink(request, {
            recipient: 'owner@example.com',
            callbackUrlPrefix: origin + start,
        });
        const other = await browser.newContext({
            ignoreHTTPSErrors: true,
            proxy: { server: browserSsoProxyUrl },
        });
        try {
            const tab = await other.newPage();
            await tab.goto(link);
            await expect(
                tab.getByText('Continue as owner@example.com.', { exact: false }),
            ).toBeVisible();
            await tab.getByRole('button', { name: 'Continue', exact: true }).click();
            await expect(
                tab.getByRole('heading', { name: 'Shared sign-in was not completed' }),
            ).toBeVisible();
            expect(
                (await other.cookies(origin)).some((cookie) => cookie.name === 'magic-sso'),
            ).toBe(true);
            expect(
                (await other.cookies(issuer)).some(
                    (cookie) => cookie.name === '__Host-magic-sso-browser',
                ),
            ).toBe(false);
            expect(
                (await context.cookies(origin)).some((cookie) => cookie.name === 'magic-sso'),
            ).toBe(false);
            await tab.getByRole('link', { name: 'Start a fresh sign-in', exact: true }).click();
            await expect(tab.getByLabel('Email', { exact: true })).toBeVisible();
            expect(new URL(tab.url()).origin).toBe(issuer);
            expect(await listMessages(request)).toHaveLength(1);
        } finally {
            await other.close();
        }
    });
}
test('central logout cancels an issued bootstrap ticket while preserving the local JWT', async ({
    page,
    request,
    context,
}) => {
    await clearMailbox(request);
    await request.post(issuer + '/test/pause-bootstrap');
    const origin = browserSsoOrigin('next'),
        destination = origin + '/protected';
    await page.goto(destination);
    await submitOtp(page, request);
    await expect(page.getByRole('heading', { name: 'Paused before shared session' })).toBeVisible();
    const ticketUrl = page.url(),
        local = (await context.cookies(destination)).find(
            (cookie) => cookie.name === 'magic-sso',
        )?.value;
    await page.goto(issuer + '/sso/signout');
    await page.getByRole('button', { name: 'End browser SSO session', exact: true }).click();
    await page.goto(ticketUrl);
    await page.getByRole('link', { name: 'Return to application', exact: true }).click();
    await expect(
        page.getByRole('heading', { name: 'Shared sign-in was not completed' }),
    ).toBeVisible();
    expect(
        (await context.cookies(destination)).find((cookie) => cookie.name === 'magic-sso')?.value,
    ).toBe(local);
    expect(
        (await context.cookies(issuer)).some(
            (cookie) => cookie.name === '__Host-magic-sso-browser',
        ),
    ).toBe(false);
    await page.goto(browserSsoOrigin('fastify') + '/protected');
    await expect(page.getByLabel('Email address', { exact: true })).toBeVisible();
});
test('a lost consumed bootstrap result is not retried and leaves the local session usable', async ({
    page,
    request,
    context,
}) => {
    await clearMailbox(request);
    await request.post(issuer + '/test/drop-bootstrap');
    const destination = browserSsoOrigin('next') + '/protected';
    await page.goto(destination);
    await submitOtp(page, request);
    await expect(
        page.getByRole('heading', { name: 'Shared sign-in result unavailable' }),
    ).toBeVisible();
    const ticketUrl = page.url(),
        local = (await context.cookies(destination)).find(
            (cookie) => cookie.name === 'magic-sso',
        )?.value;
    expect(local).toBeTruthy();
    expect(
        (await context.cookies(issuer)).some(
            (cookie) => cookie.name === '__Host-magic-sso-browser',
        ),
    ).toBe(false);
    await page.goto(destination);
    await expect(page).toHaveURL(destination);
    expect(
        (await context.cookies(destination)).find((cookie) => cookie.name === 'magic-sso')?.value,
    ).toBe(local);
    await page.goto(ticketUrl);
    await page.getByRole('link', { name: 'Return to application', exact: true }).click();
    await expect(
        page.getByRole('heading', { name: 'Shared sign-in was not completed' }),
    ).toBeVisible();
    expect(
        (await context.cookies(destination)).find((cookie) => cookie.name === 'magic-sso')?.value,
    ).toBe(local);
    expect(await listMessages(request)).toHaveLength(1);
});

test('a copied bootstrap ticket requires account confirmation and fresh app state in the other browser', async ({
    page,
    context,
    browser,
    request,
}) => {
    await clearMailbox(request);
    await request.post(issuer + '/test/pause-bootstrap');
    const origin = browserSsoOrigin('next'),
        destination = origin + '/protected';
    await page.goto(destination);
    await submitOtp(page, request);
    await expect(page.getByRole('heading', { name: 'Paused before shared session' })).toBeVisible();
    const ticketUrl = page.url(),
        originalState = new URL(ticketUrl).searchParams.get('state');
    const local = (await context.cookies(destination)).find(
        (cookie) => cookie.name === 'magic-sso',
    )?.value;
    const other = await browser.newContext({
        ignoreHTTPSErrors: true,
        proxy: { server: browserSsoProxyUrl },
    });
    try {
        const tab = await other.newPage();
        const freshStates: string[] = [];
        tab.on('request', (request) => {
            const url = new URL(request.url());
            if (url.origin === issuer && url.pathname === '/sso/authorize') {
                freshStates.push(url.searchParams.get('state') ?? '');
            }
        });
        await tab.goto(ticketUrl);
        await expect(tab.getByText('owner@example.com', { exact: true })).toBeVisible();
        expect(
            (await other.cookies(issuer)).some(
                (cookie) => cookie.name === '__Host-magic-sso-browser',
            ),
        ).toBe(false);
        await tab.getByRole('button', { name: 'Confirm shared sign-in', exact: true }).click();
        expect((await other.cookies(origin)).some((cookie) => cookie.name === 'magic-sso')).toBe(
            false,
        );
        await tab.getByRole('link', { name: 'Continue to application', exact: true }).click();
        await tab.goto(destination);
        await expect(tab).toHaveURL(destination);
        expect(freshStates).toHaveLength(1);
        expect(freshStates[0]).not.toBe(originalState);
        expect(
            (await other.cookies(destination)).some((cookie) => cookie.name === 'magic-sso'),
        ).toBe(true);
        expect(
            (await context.cookies(destination)).find((cookie) => cookie.name === 'magic-sso')
                ?.value,
        ).toBe(local);
        expect(await listMessages(request)).toHaveLength(1);
    } finally {
        await other.close();
    }
});
test('bootstrap account replacement is explicit and preserves another valid app identity', async ({
    page,
    context,
    request,
}) => {
    await clearMailbox(request);
    const first = browserSsoOrigin('gate-a'),
        second = browserSsoOrigin('next');
    await page.goto(first + '/reports');
    await submitOtp(page, request);
    await expect(page.getByTestId('email')).toHaveText('owner@example.com');
    const firstJwt = (await context.cookies(first)).find(
        (cookie) => cookie.name === 'magic-sso',
    )?.value;
    const previousCentral = (await context.cookies(issuer)).find(
        (cookie) => cookie.name === '__Host-magic-sso-browser',
    )?.value;
    await clearMailbox(request);
    await request.post(issuer + '/test/grant', {
        data: { site: 'next', email: 'other@example.com', allowed: true },
    });
    try {
        await page.goto(
            second +
                '/sso/start?' +
                new URLSearchParams({ returnUrl: '/protected', prompt: 'login' }),
        );
        await submitOtp(page, request, 'other@example.com');
        await expect(
            page.getByRole('button', { name: 'Confirm shared sign-in', exact: true }),
        ).toBeVisible();
        await expect(page.getByText('other@example.com', { exact: true })).toBeVisible();
        expect(
            (await context.cookies(issuer)).find(
                (cookie) => cookie.name === '__Host-magic-sso-browser',
            )?.value,
        ).toBe(previousCentral);
        expect(
            (await context.cookies(first)).find((cookie) => cookie.name === 'magic-sso')?.value,
        ).toBe(firstJwt);
        await page.getByRole('button', { name: 'Confirm shared sign-in', exact: true }).click();
        await expect(page).toHaveURL(second + '/protected');
        expect(
            (await context.cookies(issuer)).find(
                (cookie) => cookie.name === '__Host-magic-sso-browser',
            )?.value,
        ).not.toBe(previousCentral);
        await page.goto(first + '/reports');
        await expect(page.getByTestId('email')).toHaveText('owner@example.com');
        expect(
            (await context.cookies(first)).find((cookie) => cookie.name === 'magic-sso')?.value,
        ).toBe(firstJwt);
    } finally {
        await request.post(issuer + '/test/grant', {
            data: { site: 'next', email: 'other@example.com', allowed: false },
        });
    }
});
test('app-owned verification retains the requested scope and exact return query', async ({
    page,
    context,
    request,
}) => {
    await clearMailbox(request);
    const origin = browserSsoOrigin('next'),
        destination = origin + '/protected' + query;
    await page.goto(
        origin + '/sso/start?' + new URLSearchParams({ returnUrl: destination, scope: 'reports' }),
    );
    await submitOtp(page, request);
    await expect(page).toHaveURL(
        (url) => canonicalFlowUrl(url.href) === canonicalFlowUrl(destination),
    );
    const token = (await context.cookies(destination)).find(
        (cookie) => cookie.name === 'magic-sso',
    )?.value;
    const claims: unknown = JSON.parse(
        Buffer.from(token?.split('.')[1] ?? '', 'base64url').toString(),
    );
    expect(claims).toMatchObject({ scope: 'reports', aud: [origin] });
    expect(await listMessages(request)).toHaveLength(1);
});
