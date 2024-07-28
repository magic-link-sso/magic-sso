/**
 * server/src/email.ts
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

import nodemailer from 'nodemailer';
import type { AppConfig, SmtpTransportConfig } from './config.js';

export interface VerificationEmailInput {
    email: string;
    siteTitle: string;
    token: string;
    verifyUrl: string;
}

export interface VerificationEmailSender {
    sendVerificationEmail(input: VerificationEmailInput): Promise<void>;
}

function buildTransportOptions(transport: SmtpTransportConfig): {
    auth: {
        pass: string;
        user: string;
    };
    host: string;
    port: number;
    secure: boolean;
} {
    return {
        host: transport.host,
        port: transport.port,
        secure: transport.secure,
        auth: {
            user: transport.user,
            pass: transport.pass,
        },
    };
}

export function buildVerificationLink(verifyUrl: string, token: string): string {
    const verificationUrl = new URL(verifyUrl);
    verificationUrl.searchParams.set('token', token);
    return verificationUrl.toString();
}

function formatEmailExpiration(seconds: number): string {
    if (seconds % (60 * 60) === 0) {
        const hours = seconds / (60 * 60);
        return `${hours} ${hours === 1 ? 'hour' : 'hours'}`;
    }

    if (seconds % 60 === 0) {
        const minutes = seconds / 60;
        return `${minutes} ${minutes === 1 ? 'minute' : 'minutes'}`;
    }

    return `${seconds} ${seconds === 1 ? 'second' : 'seconds'}`;
}

function normaliseEmailSignature(signature: string): string {
    const trimmedSignature = signature.trim();
    if (trimmedSignature.length === 0 || trimmedSignature === 'Magic Link SSO') {
        return '';
    }

    return trimmedSignature;
}

function escapeHtml(value: string): string {
    return value
        .replaceAll('&', '&amp;')
        .replaceAll('<', '&lt;')
        .replaceAll('>', '&gt;')
        .replaceAll('"', '&quot;')
        .replaceAll("'", '&#39;');
}

function buildTextBody(
    verificationLink: string,
    siteTitle: string,
    expirationText: string,
    signature: string,
): string {
    const signatureBlock = signature.length > 0 ? `\n${signature}` : '';

    return `Hello,

Click the link below to sign in to ${siteTitle}:

${verificationLink}

For your security, this link expires in ${expirationText} and can only be used once.

If you did not request this email, you can safely ignore it.

Thanks,${signatureBlock}`;
}

function buildHtmlBody(
    verificationLink: string,
    siteTitle: string,
    expirationText: string,
    signature: string,
): string {
    const escapedVerificationLink = escapeHtml(verificationLink);
    const escapedSiteTitle = escapeHtml(siteTitle);
    const escapedExpirationText = escapeHtml(expirationText);
    const escapedSignature = escapeHtml(signature);
    const signatureMarkup = escapedSignature.length > 0 ? `<br>${escapedSignature}` : '';

    return `<!DOCTYPE html>
<html>
<head>
    <meta charset="UTF-8">
    <title>Sign in to ${escapedSiteTitle}</title>
    <style>
        body {
            font-family: Arial, sans-serif;
        }
        .container {
            max-width: 600px;
            margin: auto;
            padding: 20px;
            border: 1px solid #e0e0e0;
            border-radius: 10px;
            box-shadow: 0 0 10px rgba(0, 0, 0, 0.1);
        }
        .button {
            display: inline-block;
            padding: 10px 20px;
            margin: 20px 0;
            color: #fff !important;
            background-color: #007bff;
            text-decoration: none;
            border-radius: 5px;
        }
    </style>
</head>
<body>
    <div class="container">
        <h2>Hello,</h2>
        <p>Click the button below to sign in to ${escapedSiteTitle}:</p>
        <p><a href="${escapedVerificationLink}" class="button">Sign In</a></p>
        <p>For your security, this link expires in ${escapedExpirationText} and can only be used once.</p>
        <p>If you did not request this email, you can safely ignore it.</p>
        <p>Thanks,${signatureMarkup}</p>
    </div>
</body>
</html>`;
}

export function createVerificationEmailSender(config: AppConfig): VerificationEmailSender {
    const transports = [
        nodemailer.createTransport({
            host: config.emailSmtpHost,
            port: config.emailSmtpPort,
            secure: config.emailSmtpSecure,
            auth: {
                user: config.emailSmtpUser,
                pass: config.emailSmtpPass,
            },
        }),
        ...config.emailSmtpFallbacks.map((transport) =>
            nodemailer.createTransport(buildTransportOptions(transport)),
        ),
    ];

    return {
        async sendVerificationEmail(input: VerificationEmailInput): Promise<void> {
            const verificationLink = buildVerificationLink(input.verifyUrl, input.token);
            const siteTitle =
                input.siteTitle.trim().length > 0
                    ? input.siteTitle
                    : config.hostedAuthBranding.title;
            const expirationText = formatEmailExpiration(config.emailExpirationSeconds);
            const signature = normaliseEmailSignature(config.emailSignature);
            let lastError: unknown;

            for (const transporter of transports) {
                try {
                    await transporter.sendMail({
                        from: config.emailFrom,
                        to: input.email,
                        subject: `Sign in to ${siteTitle}`,
                        text: buildTextBody(verificationLink, siteTitle, expirationText, signature),
                        html: buildHtmlBody(verificationLink, siteTitle, expirationText, signature),
                    });
                    return;
                } catch (error) {
                    lastError = error;
                }
            }

            throw lastError instanceof Error ? lastError : new Error('Failed to send email.');
        },
    };
}
