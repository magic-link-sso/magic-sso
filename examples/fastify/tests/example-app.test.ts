// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Wojciech Polak

import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

const rootDir = process.cwd();
const sharedPackageDir = path.join(rootDir, '../../packages/example-ui');
const appSourcePath = path.join(rootDir, 'src/app.ts');
const authSourcePath = path.join(rootDir, 'src/auth.ts');
const htmlSourcePath = path.join(rootDir, 'src/html.ts');
const mainSourcePath = path.join(rootDir, 'src/main.ts');
const packageJsonPath = path.join(rootDir, 'package.json');
const readmePath = path.join(rootDir, 'README.md');
const sharedStylesPath = path.join(sharedPackageDir, 'styles.css');
const sharedIndexPath = path.join(sharedPackageDir, 'index.js');

describe('Fastify example app', () => {
    it('references the shared example UI package for styles and badges', async () => {
        const [appSource, htmlSource, mainSource, sharedStyles, sharedIndex, readme, packageJson] =
            await Promise.all([
                readFile(appSourcePath, 'utf8'),
                readFile(htmlSourcePath, 'utf8'),
                readFile(mainSourcePath, 'utf8'),
                readFile(sharedStylesPath, 'utf8'),
                readFile(sharedIndexPath, 'utf8'),
                readFile(readmePath, 'utf8'),
                readFile(packageJsonPath, 'utf8'),
            ]);

        expect(appSource).toContain("import.meta.resolve('magic-sso-example-ui/styles.css')");
        expect(appSource).toContain("from 'magic-sso-example-ui'");
        expect(htmlSource).toContain('signinBadgePath');
        expect(htmlSource).toContain('protectedBadgePath');
        expect(htmlSource).toContain('login-panel');
        expect(htmlSource).toContain('button-spinner');
        expect(sharedStyles).toContain('width: min(1024px, 100%);');
        expect(sharedStyles).toContain('.login-panel');
        expect(sharedIndex).toContain('signinBadgeUrl');
        expect(readme).toContain('magic-sso-example-ui');
        expect(mainSource).toContain("import 'dotenv/config';");
        expect(packageJson).toContain('"dev": "node --watch --import tsx src/main.ts"');
        expect(packageJson).toContain('"start": "node dist/main.js"');
    });

    it('implements local signin, verify-email, logout, and protected routes', async () => {
        const [appSource, authSource] = await Promise.all([
            readFile(appSourcePath, 'utf8'),
            readFile(authSourcePath, 'utf8'),
        ]);

        expect(appSource).toContain("app.post<{ Body: SignInBody }>('/api/signin'");
        expect(appSource).toContain("app.get<{ Querystring: VerifyEmailQuery }>('/verify-email'");
        expect(appSource).toContain("app.post('/logout'");
        expect(appSource).toContain("app.get('/protected'");
        expect(appSource).toContain('buildVerifyUrl');
        expect(appSource).toContain('hasSameOriginMutationSource');
        expect(appSource).toContain('MAGICSSO_PREVIEW_SECRET');
        expect(appSource).toContain('x-magic-sso-preview-secret');
        expect(authSource).toContain('buildLoginTarget');
        expect(authSource).toContain('normaliseReturnUrl');
        expect(authSource).toContain('getLoginErrorMessage');
    });
});
