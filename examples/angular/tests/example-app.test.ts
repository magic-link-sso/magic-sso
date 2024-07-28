// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Wojciech Polak

import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

const rootDir = process.cwd();
const sharedPackageDir = path.join(rootDir, '../../packages/example-ui');
const routesPath = path.join(rootDir, 'src/app/app.routes.ts');
const homePagePath = path.join(rootDir, 'src/app/home-page.component.ts');
const loginPagePath = path.join(rootDir, 'src/app/login-page.component.ts');
const magicSsoPath = path.join(rootDir, 'src/app/magic-sso.ts');
const protectedPagePath = path.join(rootDir, 'src/app/protected-page.component.ts');
const loginUtilsPath = path.join(rootDir, 'src/app/login-utils.ts');
const signinUtilsPath = path.join(rootDir, 'src/signin-utils.ts');
const serverPath = path.join(rootDir, 'src/server.ts');
const envExamplePath = path.join(rootDir, '.env.example');
const angularConfigPath = path.join(rootDir, 'angular.json');
const sharedStylesPath = path.join(sharedPackageDir, 'styles.css');
const sharedIndexPath = path.join(sharedPackageDir, 'index.js');

describe('Angular example app', () => {
    it('references the shared sign-in badge on the home and login pages', async () => {
        const [homePage, loginPage, sharedStyles, sharedIndex] = await Promise.all([
            readFile(homePagePath, 'utf8'),
            readFile(loginPagePath, 'utf8'),
            readFile(sharedStylesPath, 'utf8'),
            readFile(sharedIndexPath, 'utf8'),
        ]);

        expect(homePage).toMatch(/sharedSigninBadgeUrl/u);
        expect(homePage).toMatch(/Angular 21 SSR demo app/u);
        expect(homePage).toMatch(/<form action="\/logout" method="post">/u);
        expect(loginPage).toMatch(/button-spinner-visible/u);
        expect(loginPage).toMatch(/We'll email you a sign-in link\./u);
        expect(loginPage).toMatch(/sharedSigninBadgeUrl/u);
        expect(loginPage).toMatch(/ngNativeValidate/u);
        expect(loginPage).toMatch(/window\.location\.replace/u);
        expect(loginPage).toMatch(/typeof initialError !== 'string'/u);
        expect(sharedStyles).toContain('width: min(1024px, 100%);');
        expect(sharedStyles).toContain('grid-template-columns: 144px minmax(0, 1fr);');
        expect(sharedStyles).toContain('.button-submit');
        expect(sharedStyles).toContain('margin-top: 1.25rem;');
        expect(sharedIndex).toContain('signinBadgeUrl');
    });

    it('protects the protected page with the reusable guard and session service', async () => {
        const [routes, magicSso, protectedPage] = await Promise.all([
            readFile(routesPath, 'utf8'),
            readFile(magicSsoPath, 'utf8'),
            readFile(protectedPagePath, 'utf8'),
        ]);

        expect(routes).toMatch(/canActivate:\s*\[magicSsoAuthGuard\]/u);
        expect(routes).toMatch(/Protected \| Magic Link SSO Angular/u);
        expect(magicSso).toContain('CONFIG_STATE_KEY');
        expect(magicSso).toContain('resolveTransferredMagicSsoConfig');
        expect(protectedPage).toMatch(/MagicSsoSessionService/u);
        expect(protectedPage).toMatch(/sharedProtectedBadgeUrl/u);
        expect(protectedPage).toMatch(/<form action="\/logout" method="post">/u);
    });

    it('wires the SSR server routes for signin, verify-email, logout, and session', async () => {
        const [serverSource, angularConfig, signinUtils, envExample] = await Promise.all([
            readFile(serverPath, 'utf8'),
            readFile(angularConfigPath, 'utf8'),
            readFile(signinUtilsPath, 'utf8'),
            readFile(envExamplePath, 'utf8'),
        ]);

        expect(serverSource).toMatch(/app\.post\(\s*'\/api\/signin'/u);
        expect(serverSource).toMatch(/app\.get\(\s*'\/verify-email'/u);
        expect(serverSource).toMatch(/app\.post\(\s*'\/verify-email'/u);
        expect(serverSource).toContain("app.post('/logout'");
        expect(serverSource).toMatch(/app\.get\(\s*'\/api\/session'/u);
        expect(serverSource).toContain('AngularNodeAppEngine');
        expect(serverSource).toContain('writeResponseToNodeResponse');
        expect(serverSource).toContain("export { AngularAppEngine } from '@angular/ssr';");
        expect(serverSource).toContain('createNodeRequestHandler');
        expect(serverSource).toContain('export const reqHandler');
        expect(serverSource).toContain("import 'dotenv/config';");
        expect(serverSource).toContain('magic-sso-verify-csrf');
        expect(serverSource).toContain('magic-sso-verify-token');
        expect(serverSource).toContain('MAGICSSO_PREVIEW_SECRET');
        expect(serverSource).toContain('x-magic-sso-preview-secret');
        expect(serverSource).toContain('/verify-email');
        expect(serverSource).toContain("method: 'POST'");
        expect(serverSource).toContain("'content-type': 'application/json'");
        expect(serverSource).toContain('hasSameOriginMutationSource');
        expect(serverSource).not.toContain('name="token"');
        expect(serverSource).toContain('@media (prefers-color-scheme: dark)');
        expect(signinUtils).toContain('readServerUrlConfigError');
        expect(envExample).toContain('MAGICSSO_JWT_SECRET=VERY-VERY-LONG-RANDOM-JWT-SECRET');
        expect(envExample).toContain(
            'MAGICSSO_PREVIEW_SECRET=VERY-VERY-LONG-RANDOM-PREVIEW-SECRET',
        );
        expect(angularConfig).toContain('"outputMode": "server"');
        expect(angularConfig).toContain('"server": "src/main.server.ts"');
        expect(angularConfig).toContain('"styles": ["magic-sso-example-ui/styles.css"]');
        expect(angularConfig).toContain('"input": "../../packages/example-ui/assets"');
    });

    it('uses the shared login utilities for return-url and verify-url handling', async () => {
        const [loginPage, loginUtils] = await Promise.all([
            readFile(loginPagePath, 'utf8'),
            readFile(loginUtilsPath, 'utf8'),
        ]);

        expect(loginPage).toMatch(/buildVerifyUrl/u);
        expect(loginPage).toMatch(/buildLoginTarget/u);
        expect(loginUtils).toMatch(/getLoginErrorMessage/u);
        expect(loginUtils).toMatch(/normaliseReturnUrl/u);
        expect(loginUtils).toMatch(/buildLoginTarget/u);
    });

    it('uses the shared stylesheet for example layout styles', async () => {
        const sharedStyles = await readFile(sharedStylesPath, 'utf8');

        expect(sharedStyles).toContain('.login-panel');
        expect(sharedStyles).toContain('.message-success');
        expect(sharedStyles).toContain('@media (prefers-color-scheme: dark)');
    });
});
