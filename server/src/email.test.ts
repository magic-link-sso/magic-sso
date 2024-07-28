/**
 * server/src/email.test.ts
 *
 * Magic Link SSO Copyright (C) 2026 Wojciech Polak
 *
 * This program is free software; you can redistribute it and/or modify it
 * under the terms of the GNU General Public License as published by the
 * Free Software Foundation; either version 3 of the License, or (at your
 * option) any later version.
 *
 * This program is distributed in the hope that it will be useful,
 * but WITHOUT ANY WARRANTY; without even the implied warranty of
 * MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE. See the
 * GNU General Public License for more details.
 *
 * You should have received a copy of the GNU General Public License along
 * with this program. If not, see <https://www.gnu.org/licenses/>.
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
    createDefaultHostedAuthBranding,
    createDefaultHostedAuthPageCopy,
    type AppConfig,
    type RedirectUriRule,
} from './config.js';
import { buildVerificationLink, createVerificationEmailSender } from './email.js';

const { createTransportMock, sendMailMock } = vi.hoisted(() => {
    const sendMail = vi.fn();
    const createTransport = vi.fn(() => ({
        sendMail,
    }));

    return {
        createTransportMock: createTransport,
        sendMailMock: sendMail,
    };
});

vi.mock('nodemailer', () => ({
    default: {
        createTransport: createTransportMock,
    },
}));

function createAllowedRedirectUris(entries: string[]): RedirectUriRule[] {
    return entries.map((entry) => {
        const isSubpathRule = entry.endsWith('/*');
        const parsedUrl = new URL(isSubpathRule ? entry.slice(0, -1) : entry);

        return {
            match: isSubpathRule ? 'subpath' : 'exact',
            origin: parsedUrl.origin,
            pathname: parsedUrl.pathname,
        };
    });
}

function createConfig(): AppConfig {
    const hostedAuthBranding = createDefaultHostedAuthBranding();
    const hostedAuthPageCopy = createDefaultHostedAuthPageCopy();

    return {
        appPort: 3000,
        appUrl: 'http://sso.example.com',
        csrfSecret: 'csrf-secret',
        cookieDomain: undefined,
        cookieHttpOnly: true,
        cookieName: 'magic-sso',
        cookiePath: undefined,
        cookieSameSite: 'lax',
        cookieSecure: false,
        emailExpirationSeconds: 15 * 60,
        emailFrom: 'owner@example.com',
        emailSecret: 'email-secret',
        emailSignature: 'Magic Link SSO',
        emailSmtpHost: 'smtp.example.com',
        emailSmtpPort: 1025,
        emailSmtpPass: 'smtp-password',
        emailSmtpSecure: false,
        emailSmtpUser: 'smtp-user',
        emailSmtpFallbacks: [],
        hostedAuthBranding,
        hostedAuthPageCopy,
        healthzRateLimitMax: 60,
        logFormat: 'json',
        jwtExpirationSeconds: 60 * 60,
        jwtSecret: 'jwt-secret',
        logLevel: 'info',
        rateLimitWindowMs: 60_000,
        securityState: {
            adapter: 'file',
            keyPrefix: 'magic-sso-test',
            redisUrl: undefined,
        },
        serveRootLandingPage: true,
        previewSecret: 'preview-secret',
        signInEmailRateLimitMax: 5,
        signInEmailRateLimitStoreDir: '.magic-sso/test-signin-email-rate-limit',
        signInPageRateLimitMax: 30,
        signInRateLimitMax: 20,
        sites: [
            {
                id: 'client',
                origins: new Set(['http://client.example.com']),
                allowedRedirectUris: createAllowedRedirectUris(['http://client.example.com/*']),
                accessRules: new Map([['allowed@example.com', new Set(['*'])]]),
                hostedAuthBranding,
                hostedAuthPageCopy,
            },
        ],
        trustProxy: false,
        verifyRateLimitMax: 40,
        verifyTokenStoreDir: '.magic-sso/test-verification-tokens',
    };
}

describe('buildVerificationLink', () => {
    beforeEach(() => {
        createTransportMock.mockClear();
        sendMailMock.mockClear();
    });

    it('appends the token to a plain verification URL', () => {
        expect(buildVerificationLink('http://client.example.com/verify-email', 'test-token')).toBe(
            'http://client.example.com/verify-email?token=test-token',
        );
    });

    it('preserves existing query parameters on the verification URL', () => {
        expect(
            buildVerificationLink(
                'http://client.example.com/verify-email?returnUrl=%2Fprotected',
                'test-token',
            ),
        ).toBe('http://client.example.com/verify-email?returnUrl=%2Fprotected&token=test-token');
    });

    it('creates an SMTP transport with explicit port and security settings', async () => {
        sendMailMock.mockResolvedValue(undefined);
        const emailSender = createVerificationEmailSender(createConfig());

        await emailSender.sendVerificationEmail({
            email: 'allowed@example.com',
            siteTitle: 'Client Portal',
            token: 'email-token',
            verifyUrl: 'http://client.example.com/verify-email?returnUrl=%2Fprotected',
        });

        expect(createTransportMock).toHaveBeenCalledWith({
            host: 'smtp.example.com',
            port: 1025,
            secure: false,
            auth: {
                user: 'smtp-user',
                pass: 'smtp-password',
            },
        });
        expect(sendMailMock).toHaveBeenCalledWith(
            expect.objectContaining({
                from: 'owner@example.com',
                html: expect.stringContaining(
                    'http://client.example.com/verify-email?returnUrl=%2Fprotected&amp;token=email-token',
                ),
                subject: 'Sign in to Client Portal',
                text: expect.stringContaining(
                    'http://client.example.com/verify-email?returnUrl=%2Fprotected&token=email-token',
                ),
                to: 'allowed@example.com',
            }),
        );
    });

    it('falls back to the next SMTP transport when the primary one fails', async () => {
        const primarySendMailMock = vi.fn().mockRejectedValue(new Error('primary unavailable'));
        const fallbackSendMailMock = vi.fn().mockResolvedValue(undefined);

        createTransportMock
            .mockImplementationOnce(() => ({
                sendMail: primarySendMailMock,
            }))
            .mockImplementationOnce(() => ({
                sendMail: fallbackSendMailMock,
            }));

        const emailSender = createVerificationEmailSender({
            ...createConfig(),
            emailSmtpFallbacks: [
                {
                    host: 'smtp-backup.example.com',
                    port: 2525,
                    user: 'backup-user',
                    pass: 'backup-pass',
                    secure: true,
                },
            ],
        });

        await emailSender.sendVerificationEmail({
            email: 'allowed@example.com',
            siteTitle: 'Client Portal',
            token: 'email-token',
            verifyUrl: 'http://client.example.com/verify-email',
        });

        expect(createTransportMock).toHaveBeenNthCalledWith(1, {
            host: 'smtp.example.com',
            port: 1025,
            secure: false,
            auth: {
                user: 'smtp-user',
                pass: 'smtp-password',
            },
        });
        expect(createTransportMock).toHaveBeenNthCalledWith(2, {
            host: 'smtp-backup.example.com',
            port: 2525,
            secure: true,
            auth: {
                user: 'backup-user',
                pass: 'backup-pass',
            },
        });
        expect(primarySendMailMock).toHaveBeenCalledOnce();
        expect(fallbackSendMailMock).toHaveBeenCalledOnce();
    });

    it('escapes HTML-sensitive content in the rendered email body', async () => {
        sendMailMock.mockResolvedValue(undefined);
        const emailSender = createVerificationEmailSender({
            ...createConfig(),
            emailSignature: 'Team <script>alert("xss")</script>',
        });

        await emailSender.sendVerificationEmail({
            email: 'allowed@example.com',
            siteTitle: 'Client <Admin>',
            token: 'email-token',
            verifyUrl: 'http://client.example.com/verify-email?next=%22quoted%22&mode=<unsafe>',
        });

        const firstCall = sendMailMock.mock.calls[0]?.[0];
        expect(firstCall?.text).toContain('Click the link below to sign in to Client <Admin>:');
        expect(firstCall?.text).toContain(
            'For your security, this link expires in 15 minutes and can only be used once.',
        );
        expect(firstCall?.text).toContain(
            'If you did not request this email, you can safely ignore it.',
        );
        expect(firstCall?.html).toContain('Sign in to Client &lt;Admin&gt;');
        expect(firstCall?.html).toContain('&lt;script&gt;alert(&quot;xss&quot;)&lt;/script&gt;');
        expect(firstCall?.html).toContain(
            'next=%22quoted%22&amp;mode=%3Cunsafe%3E&amp;token=email-token',
        );
        expect(firstCall?.html).toContain(
            'For your security, this link expires in 15 minutes and can only be used once.',
        );
        expect(firstCall?.html).not.toContain('class="link"');
        expect(firstCall?.html).not.toContain('<script>alert("xss")</script>');
    });

    it('omits the default Magic Link SSO signature from the email body', async () => {
        sendMailMock.mockResolvedValue(undefined);
        const emailSender = createVerificationEmailSender(createConfig());

        await emailSender.sendVerificationEmail({
            email: 'allowed@example.com',
            siteTitle: 'Client Portal',
            token: 'email-token',
            verifyUrl: 'http://client.example.com/verify-email',
        });

        const firstCall = sendMailMock.mock.calls[0]?.[0];
        expect(firstCall?.text).toContain('\nThanks,');
        expect(firstCall?.text).not.toContain('Magic Link SSO');
        expect(firstCall?.html).not.toContain('Magic Link SSO');
    });

    it('formats expiration as singular "1 hour"', async () => {
        sendMailMock.mockResolvedValue(undefined);
        const emailSender = createVerificationEmailSender({
            ...createConfig(),
            emailExpirationSeconds: 60 * 60,
        });

        await emailSender.sendVerificationEmail({
            email: 'allowed@example.com',
            siteTitle: 'Client Portal',
            token: 'email-token',
            verifyUrl: 'http://client.example.com/verify-email',
        });

        const firstCall = sendMailMock.mock.calls[0]?.[0];
        expect(firstCall?.text).toContain('this link expires in 1 hour');
        expect(firstCall?.html).toContain('this link expires in 1 hour');
    });

    it('formats expiration as plural "2 hours"', async () => {
        sendMailMock.mockResolvedValue(undefined);
        const emailSender = createVerificationEmailSender({
            ...createConfig(),
            emailExpirationSeconds: 2 * 60 * 60,
        });

        await emailSender.sendVerificationEmail({
            email: 'allowed@example.com',
            siteTitle: 'Client Portal',
            token: 'email-token',
            verifyUrl: 'http://client.example.com/verify-email',
        });

        const firstCall = sendMailMock.mock.calls[0]?.[0];
        expect(firstCall?.text).toContain('this link expires in 2 hours');
    });

    it('formats expiration as singular "1 minute"', async () => {
        sendMailMock.mockResolvedValue(undefined);
        const emailSender = createVerificationEmailSender({
            ...createConfig(),
            emailExpirationSeconds: 60,
        });

        await emailSender.sendVerificationEmail({
            email: 'allowed@example.com',
            siteTitle: 'Client Portal',
            token: 'email-token',
            verifyUrl: 'http://client.example.com/verify-email',
        });

        const firstCall = sendMailMock.mock.calls[0]?.[0];
        expect(firstCall?.text).toContain('this link expires in 1 minute');
        expect(firstCall?.html).toContain('this link expires in 1 minute');
    });

    it('formats expiration as singular "1 second"', async () => {
        sendMailMock.mockResolvedValue(undefined);
        const emailSender = createVerificationEmailSender({
            ...createConfig(),
            emailExpirationSeconds: 1,
        });

        await emailSender.sendVerificationEmail({
            email: 'allowed@example.com',
            siteTitle: 'Client Portal',
            token: 'email-token',
            verifyUrl: 'http://client.example.com/verify-email',
        });

        const firstCall = sendMailMock.mock.calls[0]?.[0];
        expect(firstCall?.text).toContain('this link expires in 1 second');
        expect(firstCall?.html).toContain('this link expires in 1 second');
    });

    it('formats expiration as plural "2 seconds"', async () => {
        sendMailMock.mockResolvedValue(undefined);
        const emailSender = createVerificationEmailSender({
            ...createConfig(),
            emailExpirationSeconds: 2,
        });

        await emailSender.sendVerificationEmail({
            email: 'allowed@example.com',
            siteTitle: 'Client Portal',
            token: 'email-token',
            verifyUrl: 'http://client.example.com/verify-email',
        });

        const firstCall = sendMailMock.mock.calls[0]?.[0];
        expect(firstCall?.text).toContain('this link expires in 2 seconds');
    });

    it('wraps a non-Error thrown by all transports in a generic Error', async () => {
        createTransportMock.mockImplementationOnce(() => ({
            sendMail: vi.fn().mockRejectedValue('smtp connection timeout'),
        }));

        const emailSender = createVerificationEmailSender(createConfig());

        await expect(
            emailSender.sendVerificationEmail({
                email: 'allowed@example.com',
                siteTitle: 'Client Portal',
                token: 'email-token',
                verifyUrl: 'http://client.example.com/verify-email',
            }),
        ).rejects.toThrow('Failed to send email.');
    });
});
