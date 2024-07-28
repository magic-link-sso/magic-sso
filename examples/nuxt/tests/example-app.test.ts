// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Wojciech Polak

import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

const rootDir = process.cwd();
const sharedPackageDir = path.join(rootDir, '../../packages/example-ui');
const appShellPath = path.join(rootDir, 'app/app.vue');
const homePagePath = path.join(rootDir, 'app/pages/index.vue');
const loginPagePath = path.join(rootDir, 'app/pages/login.vue');
const protectedPagePath = path.join(rootDir, 'app/pages/protected.vue');
const nuxtConfigPath = path.join(rootDir, 'nuxt.config.ts');
const envExamplePath = path.join(rootDir, '.env.example');
const signInRoutePath = path.join(rootDir, 'server/api/signin.post.ts');
const verifyEmailGetRoutePath = path.join(
    rootDir,
    '../../packages/nuxt/src/runtime/server/routes/verify-email.get.ts',
);
const verifyEmailPostRoutePath = path.join(
    rootDir,
    '../../packages/nuxt/src/runtime/server/routes/verify-email.post.ts',
);
const sharedStylesPath = path.join(sharedPackageDir, 'styles.css');
const sharedIndexPath = path.join(sharedPackageDir, 'index.js');

describe('Nuxt example app', () => {
    it('references the shared sign-in badge on the home and login pages', async () => {
        const [appShell, homePage, loginPage, sharedStyles, sharedIndex] = await Promise.all([
            readFile(appShellPath, 'utf8'),
            readFile(homePagePath, 'utf8'),
            readFile(loginPagePath, 'utf8'),
            readFile(sharedStylesPath, 'utf8'),
            readFile(sharedIndexPath, 'utf8'),
        ]);

        expect(appShell).toMatch(/Magic Link SSO Nuxt/u);
        expect(homePage).toMatch(/magic-sso-example-ui\/assets\/signin-page-badge\.svg/u);
        expect(homePage).toMatch(/<form action="\/logout" method="post">/u);
        expect(loginPage).toMatch(/magic-sso-example-ui\/assets\/signin-page-badge\.svg/u);
        expect(homePage).toMatch(/buildLoginTarget/u);
        expect(loginPage).toMatch(/button-spinner/u);
        expect(loginPage).toMatch(/login-panel/u);
        expect(sharedStyles).toContain('width: min(1024px, 100%);');
        expect(sharedStyles).toContain('grid-template-columns: 144px minmax(0, 1fr);');
        expect(sharedIndex).toContain('signinBadgeUrl');
    });

    it('protects the protected page with the reusable middleware and helper', async () => {
        const protectedPage = await readFile(protectedPagePath, 'utf8');

        expect(protectedPage).toMatch(/middleware:\s*\['magic-sso-auth'\]/u);
        expect(protectedPage).toMatch(/useMagicSsoAuth/u);
        expect(protectedPage).toMatch(/Protected \| Magic Link SSO Nuxt/u);
        expect(protectedPage).toMatch(/magic-sso-example-ui\/assets\/protected-page-badge\.svg/u);
        expect(protectedPage).toMatch(/<form action="\/logout" method="post">/u);
        expect(protectedPage).toContain('href="/"');
    });

    it('maps the Magic Link SSO env variables into runtime config', async () => {
        const nuxtConfig = await readFile(nuxtConfigPath, 'utf8');

        expect(nuxtConfig).toMatch(/MAGICSSO_SERVER_URL/u);
        expect(nuxtConfig).toMatch(/APP_URL/u);
        expect(nuxtConfig).toMatch(/MAGICSSO_PREVIEW_SECRET/u);
        expect(nuxtConfig).toMatch(/MAGICSSO_JWT_SECRET/u);
        expect(nuxtConfig).toMatch(/JWT_SECRET/u);
        expect(nuxtConfig).toMatch(/MAGICSSO_COOKIE_NAME/u);
        expect(nuxtConfig).toMatch(/COOKIE_NAME/u);
        expect(nuxtConfig).toMatch(/MAGICSSO_PUBLIC_ORIGIN/u);
        expect(nuxtConfig).toMatch(/PUBLIC_ORIGIN/u);
        expect(nuxtConfig).toMatch(/MAGICSSO_DIRECT_USE/u);
        expect(nuxtConfig).toContain('magic-sso-example-ui/styles.css');
        expect(nuxtConfig).toContain("'/assets'");
        expect(nuxtConfig).not.toMatch(/signin-page-badge\.svg/u);
    });

    it('posts sign-in requests with a local verify callback URL', async () => {
        const [loginPage, signInRoute, verifyEmailGetRoute, verifyEmailPostRoute] =
            await Promise.all([
                readFile(loginPagePath, 'utf8'),
                readFile(signInRoutePath, 'utf8'),
                readFile(verifyEmailGetRoutePath, 'utf8'),
                readFile(verifyEmailPostRoutePath, 'utf8'),
            ]);

        expect(loginPage).toMatch(/verifyUrl/u);
        expect(signInRoute).toMatch(/verifyUrl/u);
        expect(signInRoute).toContain('fetch(`${serverUrl}/signin`');
        expect(signInRoute).toContain('process.env.MAGICSSO_SERVER_URL');
        expect(signInRoute).toContain('process.env.APP_URL');
        expect(verifyEmailGetRoute).toContain('/verify-email');
        expect(verifyEmailGetRoute).toContain('Continue sign-in');
        expect(verifyEmailGetRoute).toContain('@media (prefers-color-scheme: dark)');
        expect(verifyEmailPostRoute).toContain('readBody');
        expect(verifyEmailPostRoute).toContain("verifyCsrfCookieName = 'magic-sso-verify-csrf'");
        expect(verifyEmailPostRoute).toContain("method: 'POST'");
        expect(verifyEmailGetRoute).toContain('x-magic-sso-preview-secret');
    });

    it('styles the login form for dark mode', async () => {
        const [loginPage, sharedStyles] = await Promise.all([
            readFile(loginPagePath, 'utf8'),
            readFile(sharedStylesPath, 'utf8'),
        ]);

        expect(loginPage).toContain('class="field-input"');
        expect(sharedStyles).toMatch(/@media \(prefers-color-scheme: dark\)/u);
        expect(sharedStyles).toContain('.login-panel');
        expect(sharedStyles).toContain('.field-input');
        expect(sharedStyles).toContain('.button-primary');
        expect(sharedStyles).toContain('.button-spinner');
        expect(sharedStyles).toContain('margin-right 150ms ease');
    });

    it('bootstraps missing Nuxt env files from the checked-in example', async () => {
        const [packageJson, envExample] = await Promise.all([
            readFile(path.join(rootDir, 'package.json'), 'utf8'),
            readFile(envExamplePath, 'utf8'),
        ]);

        expect(packageJson).toContain('node scripts/ensure-env.mjs');
        expect(envExample).toContain('MAGICSSO_PUBLIC_ORIGIN=http://localhost:3002');
    });
});
