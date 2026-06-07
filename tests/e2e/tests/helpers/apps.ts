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

type ExampleAppSeed = Omit<ExampleAppDefinition, 'expectLoginPage'> & {
    loginUrlPattern?: RegExp;
};

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

function escapeRegex(value: string): string {
    return value.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&');
}

function createExpectLoginPage(loginPath: string, loginHeading: string, loginUrlPattern: RegExp) {
    return async function expectLoginPage(page: Page, expectedReturnUrl: string): Promise<void> {
        await expect(page).toHaveURL(loginUrlPattern);
        await expect(page.getByRole('heading', { name: loginHeading })).toBeVisible();
        const currentUrl = new URL(page.url());
        expect(currentUrl.pathname).toBe(loginPath);
        expectReturnUrl(page, expectedReturnUrl);
    };
}

function createDefaultExpectAuthenticated(
    appUrl: string,
    successHeading: string,
    options?: { emailTarget?: 'forwarded-email' },
) {
    return async function expectAuthenticated(
        page: Page,
        email: string,
        protectedPath: string,
    ): Promise<void> {
        await expect(page).toHaveURL(`${appUrl}${protectedPath}`);
        await expect(page.getByRole('heading', { name: successHeading })).toBeVisible();
        if (options?.emailTarget === 'forwarded-email') {
            await expect(page.locator('#forwarded-email')).toContainText(email);
            return;
        }

        await expectEmailVisible(page, email);
    };
}

function defineExampleApp(seed: ExampleAppSeed): ExampleAppDefinition {
    return {
        ...seed,
        expectLoginPage: createExpectLoginPage(
            seed.loginPath,
            seed.loginHeading,
            seed.loginUrlPattern ?? new RegExp(`${escapeRegex(seed.loginPath)}\\?`, 'u'),
        ),
    };
}

export const exampleApps: readonly ExampleAppDefinition[] = [
    defineExampleApp({
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
        expectAuthenticated: createDefaultExpectAuthenticated(
            buildAppUrl(43104),
            'Your Angular session is locked in and verified.',
        ),
    }),
    defineExampleApp({
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
        expectAuthenticated: createDefaultExpectAuthenticated(
            buildAppUrl(43103),
            'Your Django session is locked in and verified.',
        ),
        loginUrlPattern: /\/sso\/login\/\?/u,
    }),
    defineExampleApp({
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
        expectAuthenticated: createDefaultExpectAuthenticated(
            buildAppUrl(43105),
            'Your Fastify session is locked in and verified.',
        ),
    }),
    defineExampleApp({
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
        expectAuthenticated: createDefaultExpectAuthenticated(
            buildAppUrl(43106),
            'Your private1 session is locked in and proxied.',
            { emailTarget: 'forwarded-email' },
        ),
        loginUrlPattern: /\/_magicgate\/login\?/u,
    }),
    defineExampleApp({
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
        loginUrlPattern: /\/_magicgate\/login\?/u,
    }),
    defineExampleApp({
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
        expectAuthenticated: createDefaultExpectAuthenticated(
            buildAppUrl(43101),
            'Your Next.js session is locked in and verified.',
        ),
    }),
    defineExampleApp({
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
        expectAuthenticated: createDefaultExpectAuthenticated(
            buildAppUrl(43102),
            'Your Nuxt session is locked in and verified.',
        ),
    }),
];
