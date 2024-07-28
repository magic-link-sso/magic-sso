import { expect, type Page } from '@playwright/test';

export interface ExampleAppDefinition {
    readonly allowedEmail: string;
    readonly appUrl: string;
    readonly blockedEmail: string;
    readonly displayName: string;
    readonly loginHeading: string;
    readonly loginPath: string;
    readonly name: 'angular' | 'django' | 'fastify' | 'nextjs' | 'nuxt' | 'private1' | 'private2';
    readonly protectedPaths: readonly string[];
    readonly successHeading: string;
    readonly verifyPath: string;
    expectAuthenticated(page: Page, email: string, protectedPath: string): Promise<void>;
    expectLoginPage(page: Page, expectedReturnUrl: string): Promise<void>;
}

function expectReturnUrl(page: Page, expectedReturnUrl: string): void {
    const currentUrl = new URL(page.url());
    expect(currentUrl.searchParams.get('returnUrl')).toBe(expectedReturnUrl);
}

async function expectEmailVisible(page: Page, email: string): Promise<void> {
    await expect(page.getByText(email)).toBeVisible();
}

function buildAppUrl(port: number): string {
    return `http://localhost:${port}`;
}

export const exampleApps: readonly ExampleAppDefinition[] = [
    {
        allowedEmail: 'angular@example.com',
        appUrl: buildAppUrl(43104),
        blockedEmail: 'blocked-angular@example.com',
        displayName: 'Angular',
        loginHeading: 'Sign in',
        loginPath: '/login',
        name: 'angular',
        protectedPaths: ['/protected'],
        successHeading: 'Your Angular session is locked in and verified.',
        verifyPath: '/verify-email',
        async expectAuthenticated(page: Page, email: string, protectedPath: string): Promise<void> {
            await expect(page).toHaveURL(`${buildAppUrl(43104)}${protectedPath}`);
            await expect(
                page.getByRole('heading', {
                    name: 'Your Angular session is locked in and verified.',
                }),
            ).toBeVisible();
            await expectEmailVisible(page, email);
        },
        async expectLoginPage(page: Page, expectedReturnUrl: string): Promise<void> {
            await expect(page).toHaveURL(/\/login\?/u);
            await expect(page.getByRole('heading', { name: 'Sign in' })).toBeVisible();
            const currentUrl = new URL(page.url());
            expect(currentUrl.pathname).toBe('/login');
            expectReturnUrl(page, expectedReturnUrl);
        },
    },
    {
        allowedEmail: 'django@example.com',
        appUrl: buildAppUrl(43103),
        blockedEmail: 'blocked-django@example.com',
        displayName: 'Django',
        loginHeading: 'Sign in',
        loginPath: '/sso/login/',
        name: 'django',
        protectedPaths: ['/protected1', '/protected2'],
        successHeading: 'Your Django session is locked in and verified.',
        verifyPath: '/sso/verify-email/',
        async expectAuthenticated(page: Page, email: string, protectedPath: string): Promise<void> {
            await expect(page).toHaveURL(`${buildAppUrl(43103)}${protectedPath}`);
            await expect(
                page.getByRole('heading', {
                    name: 'Your Django session is locked in and verified.',
                }),
            ).toBeVisible();
            await expectEmailVisible(page, email);
        },
        async expectLoginPage(page: Page, expectedReturnUrl: string): Promise<void> {
            await expect(page).toHaveURL(/\/sso\/login\/\?/u);
            await expect(page.getByRole('heading', { name: 'Sign in' })).toBeVisible();
            const currentUrl = new URL(page.url());
            expect(currentUrl.pathname).toBe('/sso/login/');
            expectReturnUrl(page, expectedReturnUrl);
        },
    },
    {
        allowedEmail: 'fastify@example.com',
        appUrl: buildAppUrl(43105),
        blockedEmail: 'blocked-fastify@example.com',
        displayName: 'Fastify',
        loginHeading: 'Sign in',
        loginPath: '/login',
        name: 'fastify',
        protectedPaths: ['/protected'],
        successHeading: 'Your Fastify session is locked in and verified.',
        verifyPath: '/verify-email',
        async expectAuthenticated(page: Page, email: string, protectedPath: string): Promise<void> {
            await expect(page).toHaveURL(`${buildAppUrl(43105)}${protectedPath}`);
            await expect(
                page.getByRole('heading', {
                    name: 'Your Fastify session is locked in and verified.',
                }),
            ).toBeVisible();
            await expectEmailVisible(page, email);
        },
        async expectLoginPage(page: Page, expectedReturnUrl: string): Promise<void> {
            await expect(page).toHaveURL(/\/login\?/u);
            await expect(page.getByRole('heading', { name: 'Sign in' })).toBeVisible();
            const currentUrl = new URL(page.url());
            expect(currentUrl.pathname).toBe('/login');
            expectReturnUrl(page, expectedReturnUrl);
        },
    },
    {
        allowedEmail: 'private1@example.com',
        appUrl: buildAppUrl(43106),
        blockedEmail: 'blocked-private1@example.com',
        displayName: 'private1',
        loginHeading: 'Sign in',
        loginPath: '/_magicgate/login',
        name: 'private1',
        protectedPaths: ['/'],
        successHeading: 'Your private1 session is locked in and proxied.',
        verifyPath: '/_magicgate/verify-email',
        async expectAuthenticated(page: Page, email: string, protectedPath: string): Promise<void> {
            await expect(page).toHaveURL(`${buildAppUrl(43106)}${protectedPath}`);
            await expect(
                page.getByRole('heading', {
                    name: 'Your private1 session is locked in and proxied.',
                }),
            ).toBeVisible();
            await expect(page.locator('#forwarded-email')).toContainText(email);
        },
        async expectLoginPage(page: Page, expectedReturnUrl: string): Promise<void> {
            await expect(page).toHaveURL(/\/_magicgate\/login\?/u);
            await expect(page.getByRole('heading', { name: 'Sign in' })).toBeVisible();
            const currentUrl = new URL(page.url());
            expect(currentUrl.pathname).toBe('/_magicgate/login');
            expectReturnUrl(page, expectedReturnUrl);
        },
    },
    {
        allowedEmail: 'private2@example.com',
        appUrl: buildAppUrl(43109),
        blockedEmail: 'blocked-private2@example.com',
        displayName: 'private2',
        loginHeading: 'Sign in',
        loginPath: '/_magicgate/login',
        name: 'private2',
        protectedPaths: ['/'],
        successHeading: 'Your private2 static page is locked behind the gate.',
        verifyPath: '/_magicgate/verify-email',
        async expectAuthenticated(
            page: Page,
            _email: string,
            protectedPath: string,
        ): Promise<void> {
            await expect(page).toHaveURL(`${buildAppUrl(43109)}${protectedPath}`);
            await expect(
                page.getByRole('heading', {
                    name: 'Your private2 static page is locked behind the gate.',
                }),
            ).toBeVisible();
            await expect(
                page.getByText('This is plain HTML served by a tiny file server.'),
            ).toBeVisible();
            await expect(page.locator('#asset-status')).toContainText(
                'Static assets loaded through Gate.',
            );
        },
        async expectLoginPage(page: Page, expectedReturnUrl: string): Promise<void> {
            await expect(page).toHaveURL(/\/_magicgate\/login\?/u);
            await expect(page.getByRole('heading', { name: 'Sign in' })).toBeVisible();
            const currentUrl = new URL(page.url());
            expect(currentUrl.pathname).toBe('/_magicgate/login');
            expectReturnUrl(page, expectedReturnUrl);
        },
    },
    {
        allowedEmail: 'nextjs@example.com',
        appUrl: buildAppUrl(43101),
        blockedEmail: 'blocked-nextjs@example.com',
        displayName: 'Next.js',
        loginHeading: 'Sign in',
        loginPath: '/login',
        name: 'nextjs',
        protectedPaths: ['/protected'],
        successHeading: 'Your Next.js session is locked in and verified.',
        verifyPath: '/verify-email',
        async expectAuthenticated(page: Page, email: string, protectedPath: string): Promise<void> {
            await expect(page).toHaveURL(`${buildAppUrl(43101)}${protectedPath}`);
            await expect(
                page.getByRole('heading', {
                    name: 'Your Next.js session is locked in and verified.',
                }),
            ).toBeVisible();
            await expectEmailVisible(page, email);
        },
        async expectLoginPage(page: Page, expectedReturnUrl: string): Promise<void> {
            await expect(page).toHaveURL(/\/login\?/u);
            await expect(page.getByRole('heading', { name: 'Sign in' })).toBeVisible();
            const currentUrl = new URL(page.url());
            expect(currentUrl.pathname).toBe('/login');
            expectReturnUrl(page, expectedReturnUrl);
        },
    },
    {
        allowedEmail: 'nuxt@example.com',
        appUrl: buildAppUrl(43102),
        blockedEmail: 'blocked-nuxt@example.com',
        displayName: 'Nuxt',
        loginHeading: 'Sign in',
        loginPath: '/login',
        name: 'nuxt',
        protectedPaths: ['/protected'],
        successHeading: 'Your Nuxt session is locked in and verified.',
        verifyPath: '/verify-email',
        async expectAuthenticated(page: Page, email: string, protectedPath: string): Promise<void> {
            await expect(page).toHaveURL(`${buildAppUrl(43102)}${protectedPath}`);
            await expect(
                page.getByRole('heading', { name: 'Your Nuxt session is locked in and verified.' }),
            ).toBeVisible();
            await expectEmailVisible(page, email);
        },
        async expectLoginPage(page: Page, expectedReturnUrl: string): Promise<void> {
            await expect(page).toHaveURL(/\/login\?/u);
            await expect(page.getByRole('heading', { name: 'Sign in' })).toBeVisible();
            const currentUrl = new URL(page.url());
            expect(currentUrl.pathname).toBe('/login');
            expectReturnUrl(page, expectedReturnUrl);
        },
    },
];
