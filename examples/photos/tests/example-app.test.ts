// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Wojciech Polak

import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

const rootDir = process.cwd();
const globalsCssPath = path.join(rootDir, 'src/app/globals.css');
const verifyEmailRoutePath = path.join(rootDir, 'src/app/verify-email/route.ts');
const loginFormPath = path.join(rootDir, 'src/app/login/LoginForm.tsx');
const verifyOtpRoutePath = path.join(rootDir, 'src/app/api/verify-email/otp/route.ts');

describe('Photos example app', () => {
    it('supports an automatic dark mode across the shared app stylesheet', async () => {
        const globalsCss = await readFile(globalsCssPath, 'utf8');

        expect(globalsCss).toContain('color-scheme: light dark;');
        expect(globalsCss).toContain('@media (prefers-color-scheme: dark)');
        expect(globalsCss).toContain('--viewer-surface: rgba(18, 24, 23, 0.92);');
        expect(globalsCss).toContain('.button-ghost');
        expect(globalsCss).toContain('.field-input::placeholder');
    });

    it('keeps the verify-email screen aligned with dark-mode auto styling', async () => {
        const verifyEmailRoute = await readFile(verifyEmailRoutePath, 'utf8');

        expect(verifyEmailRoute).toContain('@media (prefers-color-scheme: dark)');
        expect(verifyEmailRoute).toContain('Continue sign-in');
    });

    it('keeps OTP exchange server-side for an already-open Photos session', async () => {
        const [loginForm, verifyOtpRoute] = await Promise.all([
            readFile(loginFormPath, 'utf8'),
            readFile(verifyOtpRoutePath, 'utf8'),
        ]);

        expect(loginForm).toContain('autoComplete="one-time-code"');
        expect(loginForm).toContain('/api/verify-email/otp');
        expect(loginForm).toContain('form.hidden = true');
        expect(loginForm).toContain('Use a different email');
        expect(loginForm).toContain("otpChallenge.value = ''");
        expect(loginForm).toContain('Check your email');
        expect(loginForm).toContain('showConfirmation');
        expect(loginForm).toContain("otpCode.placeholder = otpLength === 6 ? '123456' : ''");
        expect(verifyOtpRoute).toContain('VerifyEmailOtpRoute');
    });
});
