// SPDX-License-Identifier: GPL-3.0-or-later

import { createConnection, type Socket } from 'node:net';
import nodemailer from 'nodemailer';
import type { AppConfig, SmtpTransportConfig } from './config.js';
import {
    addDiagnostic,
    withDiagnosticTimeout,
    type DiagnosticReport,
} from '@magic-link-sso/config-core/diagnostics';

async function smtpOperation(
    config: SmtpTransportConfig,
    timeoutMs: number,
    message?: { from: string; to: string },
): Promise<void> {
    let socket: Socket | undefined;
    let transport: ReturnType<typeof nodemailer.createTransport> | undefined;
    try {
        await withDiagnosticTimeout(timeoutMs, async (signal) => {
            transport = nodemailer.createTransport({
                ...config,
                auth: { user: config.user, pass: config.pass },
                connectionTimeout: timeoutMs,
                greetingTimeout: timeoutMs,
                socketTimeout: timeoutMs,
                getSocket(_options, callback) {
                    socket = createConnection({ host: config.host, port: config.port, signal });
                    const failed = (error: Error): void => {
                        callback(error, false);
                    };
                    socket.once('error', failed);
                    socket.once('connect', () => {
                        socket?.removeListener('error', failed);
                        callback(null, { connection: socket });
                    });
                },
            });
            if (message) {
                const result = await transport.sendMail({
                    ...message,
                    subject: 'Magic Link SSO diagnostic test',
                    text: 'This is an operator-requested Magic Link SSO SMTP test. It contains no sign-in link or code.',
                });
                if (result.accepted.length === 0) {
                    throw new Error('Recipient not accepted');
                }
            } else {
                await transport.verify();
            }
        });
    } finally {
        socket?.destroy();
        transport?.close();
    }
}

export async function checkDoctorSmtp(
    report: DiagnosticReport,
    config: AppConfig,
    timeoutMs: number,
    recipient?: string,
): Promise<void> {
    const transports: SmtpTransportConfig[] = [
        {
            host: config.emailSmtpHost,
            port: config.emailSmtpPort,
            secure: config.emailSmtpSecure,
            user: config.emailSmtpUser,
            pass: config.emailSmtpPass,
        },
        ...config.emailSmtpFallbacks,
    ];
    const available: boolean[] = [];
    for (const transport of transports) {
        try {
            await smtpOperation(transport, timeoutMs);
            available.push(true);
        } catch {
            available.push(false);
        }
    }
    const anyAvailable = available.includes(true);
    for (const [index, success] of available.entries()) {
        addDiagnostic(report, {
            id: `smtp.${index}`,
            setting: index === 0 ? 'email.smtp' : `email.smtpFallbacks.${index - 1}`,
            status: smtpStatus(success, anyAvailable),
            message: success
                ? 'SMTP verification succeeded; delivery is unverified.'
                : 'SMTP connection or authentication failed or timed out.',
            correction: success
                ? ''
                : 'Check host, port, TLS, credentials and outbound network access.',
        });
    }
    if (!recipient) {
        return;
    }
    await sendDiagnosticEmail(report, config, transports, timeoutMs, recipient);
}

function smtpStatus(success: boolean, anyAvailable: boolean): 'pass' | 'warn' | 'fail' {
    if (success) {
        return 'pass';
    }
    return anyAvailable ? 'warn' : 'fail';
}

async function sendDiagnosticEmail(
    report: DiagnosticReport,
    config: AppConfig,
    transports: SmtpTransportConfig[],
    timeoutMs: number,
    recipient: string,
): Promise<void> {
    for (const transport of transports) {
        try {
            await smtpOperation(transport, timeoutMs, { from: config.emailFrom, to: recipient });
            addDiagnostic(report, {
                id: 'smtp.test-email',
                setting: 'email.from',
                status: 'pass',
                message:
                    'SMTP accepted the diagnostic message; check the recipient inbox for delivery.',
                correction: '',
            });
            return;
        } catch {
            /* Follow the same transport order as ordinary email sending. */
        }
    }
    addDiagnostic(report, {
        id: 'smtp.test-email',
        setting: 'email.smtp',
        status: 'fail',
        message: 'No transport accepted the diagnostic message.',
        correction: 'Check the sender, recipient and SMTP relay policy.',
    });
}
