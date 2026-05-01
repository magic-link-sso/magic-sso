// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Wojciech Polak

import { readFile } from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';
import assert from 'node:assert/strict';

const rootDir = process.cwd();
const sharedPackageDir = path.join(rootDir, '../../packages/example-ui');
const nextHomePagePath = path.join(rootDir, 'src/app/page.tsx');
const nextLayoutPath = path.join(rootDir, 'src/app/layout.tsx');
const nextLoginUrlPath = path.join(rootDir, 'src/app/login/url.ts');
const nextLoginFormPath = path.join(rootDir, 'src/app/login/LoginForm.tsx');
const nextLoginPagePath = path.join(rootDir, 'src/app/login/page.tsx');
const nextLoginSigninPath = path.join(rootDir, 'src/app/login/signin.ts');
const nextSignInRoutePath = path.join(rootDir, 'src/app/api/signin/route.ts');
const nextLogoutRoutePath = path.join(rootDir, 'src/app/logout/route.ts');
const nextVerifyEmailRoutePath = path.join(rootDir, 'src/app/verify-email/route.ts');
const nextProtectedPagePath = path.join(rootDir, 'src/app/protected/page.tsx');
const nextPackageJsonPath = path.join(rootDir, 'package.json');
const nextProxyPath = path.join(rootDir, 'src/proxy.ts');
const sharedIndexPath = path.join(sharedPackageDir, 'index.js');
const sharedStylesPath = path.join(sharedPackageDir, 'styles.css');

test('home page references the shared sign-in badge icon', async () => {
    const [homePage, layoutSource, loginUrl, sharedIndex, sharedStyles] = await Promise.all([
        readFile(nextHomePagePath, 'utf8'),
        readFile(nextLayoutPath, 'utf8'),
        readFile(nextLoginUrlPath, 'utf8'),
        readFile(sharedIndexPath, 'utf8'),
        readFile(sharedStylesPath, 'utf8'),
    ]);

    assert.match(layoutSource, /magic-sso-example-ui\/styles\.css/u);
    assert.match(homePage, /signinBadgeUrl/u);
    assert.match(homePage, /buildLoginTarget/u);
    assert.match(homePage, /className="card hero"/u);
    assert.match(sharedIndex, /signinBadgeUrl/u);
    assert.match(sharedStyles, /\.hero-top/u);
    assert.match(loginUrl, /MAGICSSO_DIRECT_USE/u);
    assert.match(loginUrl, /MAGICSSO_SERVER_URL/u);
});

test('protected page references the shared protected badge icon', async () => {
    const [protectedPage, logoutRoute] = await Promise.all([
        readFile(nextProtectedPagePath, 'utf8'),
        readFile(nextLogoutRoutePath, 'utf8'),
    ]);

    assert.match(protectedPage, /protectedBadgeUrl/u);
    assert.match(protectedPage, /Protected \| Magic Link SSO Next\.js/u);
    assert.match(protectedPage, /Your Next\.js session is locked in and verified\./u);
    assert.match(protectedPage, /Next Steps/u);
    assert.match(protectedPage, /<form action="\/logout" method="post">/u);
    assert.match(protectedPage, /<button type="submit" className="button button-secondary">/u);
    assert.match(logoutRoute, /export const POST = LogoutRoute/u);
    assert.doesNotMatch(logoutRoute, /export const GET = LogoutRoute/u);
});

test('login flow sends sign-in requests with a client verify callback', async () => {
    const [loginPage, loginForm, loginSignin, signInRoute, verifyEmailRoute] = await Promise.all([
        readFile(nextLoginPagePath, 'utf8'),
        readFile(nextLoginFormPath, 'utf8'),
        readFile(nextLoginSigninPath, 'utf8'),
        readFile(nextSignInRoutePath, 'utf8'),
        readFile(nextVerifyEmailRoutePath, 'utf8'),
    ]);

    assert.match(loginPage, /appOrigin/u);
    assert.match(loginPage, /getAppOrigin/u);
    assert.match(loginPage, /verification-email-sent/u);
    assert.match(loginForm, /action="\/api\/signin"/u);
    assert.match(loginForm, /method="post"/u);
    assert.match(loginForm, /verifyUrl/u);
    assert.match(loginForm, /event\.preventDefault\(\)/u);
    assert.match(loginForm, /accept:\s*'application\/json'/u);
    assert.match(loginForm, /data-submit-spinner/u);
    assert.match(loginForm, /button-spinner-visible/u);
    assert.match(loginSignin, /new URL\('\/signin', serverUrl\)/u);
    assert.match(signInRoute, /buildLoginRedirect/u);
    assert.match(signInRoute, /success: 'verification-email-sent'/u);
    assert.match(
        signInRoute,
        /NextResponse\.json\(\{ message: 'Verification email sent', success: true \}\)/u,
    );
    assert.match(verifyEmailRoute, /verify-email/u);
    assert.match(verifyEmailRoute, /export async function POST/u);
    assert.match(verifyEmailRoute, /method:\s*'POST'/u);
    assert.match(verifyEmailRoute, /'content-type':\s*'application\/json'/u);
    assert.match(verifyEmailRoute, /Continue sign-in/u);
    assert.match(verifyEmailRoute, /id="email-value"/u);
    assert.doesNotMatch(verifyEmailRoute, /readonly/u);
    assert.doesNotMatch(verifyEmailRoute, /name="token"/u);
    assert.match(verifyEmailRoute, /magic-sso-verify-token/u);
    assert.match(verifyEmailRoute, /@media \(prefers-color-scheme: dark\)/u);
    assert.match(verifyEmailRoute, /cookies\.set/u);
    assert.match(verifyEmailRoute, /buildAuthCookieOptions/u);
    assert.match(verifyEmailRoute, /MAGICSSO_PREVIEW_SECRET/u);
    assert.match(verifyEmailRoute, /x-magic-sso-preview-secret/u);
});

test('login form includes dedicated dark-mode styles', async () => {
    const [loginForm, sharedStyles] = await Promise.all([
        readFile(nextLoginFormPath, 'utf8'),
        readFile(sharedStylesPath, 'utf8'),
    ]);

    assert.match(loginForm, /signinBadgeUrl/u);
    assert.match(loginForm, /Sending magic link/u);
    assert.match(loginForm, /className="field-input"/u);
    assert.match(sharedStyles, /@media \(prefers-color-scheme: dark\)/u);
    assert.match(sharedStyles, /\.login-panel/u);
});

test('proxy relies on framework static routes instead of old public badge exceptions', async () => {
    const [proxySource, sharedIndex] = await Promise.all([
        readFile(nextProxyPath, 'utf8'),
        readFile(sharedIndexPath, 'utf8'),
    ]);

    assert.doesNotMatch(proxySource, /signin-page-badge\.svg/u);
    assert.match(proxySource, /api\/signin/u);
    assert.match(sharedIndex, /protected-page-badge\.svg/u);
});

test('package scripts clear the Next.js build cache before dev and build', async () => {
    const packageJson = await readFile(nextPackageJsonPath, 'utf8');

    assert.match(packageJson, /"clean": "rm -rf \.next"/u);
    assert.match(
        packageJson,
        /"dev": "node scripts\/ensure-env\.mjs && pnpm run clean && pnpm --filter @magic-link-sso\/nextjs build && exec next dev --webpack -p 3001"/u,
    );
    assert.match(packageJson, /"build": "node scripts\/ensure-env\.mjs && pnpm run clean/u);
    assert.match(packageJson, /"start": "node scripts\/ensure-env\.mjs && next start -p 3001"/u);
});
