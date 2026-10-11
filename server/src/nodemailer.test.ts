import nodemailer from 'nodemailer';
import { describe, expect, it } from 'vitest';

describe('Nodemailer transport compatibility', () => {
    it('composes a verification email with the expected recipient and body', async () => {
        const transport = nodemailer.createTransport({ streamTransport: true, buffer: true });
        const verificationLink = 'https://sso.example.com/verify?token=test-token';
        const message = await transport.sendMail({
            from: 'Magic Link SSO <sso@example.com>',
            to: 'user@example.com',
            subject: 'Sign in to Magic Link SSO',
            text: verificationLink,
            html: `<a href="${verificationLink}">Sign In</a>`,
        });

        expect(message.envelope).toEqual({
            from: 'sso@example.com',
            to: ['user@example.com'],
        });
        expect(Buffer.isBuffer(message.message)).toBe(true);
        expect(message.message.toString()).toContain('Subject: Sign in to Magic Link SSO');
        expect(message.message.toString()).toContain(verificationLink);
    });

    it.each([
        ['"user"@example.com(x)evil.com', 'user@example.com'],
        ['"a"@b.com(c)d.com(e)f.com', 'a@b.com'],
    ])('keeps trailing domain text out of the envelope for %s', async (recipient, expected) => {
        const transport = nodemailer.createTransport({ streamTransport: true, buffer: true });
        const message = await transport.sendMail({
            from: 'sso@example.com',
            to: recipient,
            subject: 'Sign in',
            text: 'Verification link',
        });

        expect(message.envelope.to).toEqual([expected]);
    });
});
