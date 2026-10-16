// SPDX-License-Identifier: GPL-3.0-or-later

import { createServer, type Server, type Socket } from 'node:net';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { parseMagicSsoConfigToml, type SmtpTransportConfig } from './config.js';
import { checkDoctorSmtp } from './doctorSmtp.js';
import { runServerDoctor } from './doctor.js';
import type { DiagnosticReport } from '@magic-link-sso/config-core/diagnostics';

const servers: Server[] = [];
const sockets = new Set<Socket>();
async function smtp(
    mode: 'ok' | 'reject' | 'stall' | 'reject-mail' = 'ok',
): Promise<{ config: SmtpTransportConfig; messages: string[]; connections: () => number }> {
    const messages: string[] = [];
    let connections = 0;
    const server = createServer((socket) => {
        connections += 1;
        sockets.add(socket);
        socket.on('close', () => sockets.delete(socket));
        socket.on('error', () => undefined);
        if (mode === 'stall') {
            return;
        }
        socket.write('220 localhost SMTP\r\n');
        let pending = '';
        let data: string[] | undefined;
        socket.on('data', (chunk) => {
            pending += chunk.toString();
            let end: number;
            while ((end = pending.indexOf('\r\n')) !== -1) {
                const line = pending.slice(0, end);
                pending = pending.slice(end + 2);
                if (data) {
                    if (line === '.') {
                        messages.push(data.join('\n'));
                        data = undefined;
                        socket.write('250 accepted\r\n');
                    } else {
                        data.push(line);
                    }
                    continue;
                }
                const reply = smtpReply(line, mode);
                if (line === 'DATA') {
                    data = [];
                }
                if (line === 'QUIT') {
                    socket.end(reply);
                } else {
                    socket.write(reply);
                }
            }
        });
    });
    servers.push(server);
    await new Promise<void>((resolve, reject) => {
        server.once('error', reject);
        server.listen(0, '127.0.0.1', resolve);
    });
    const address = server.address();
    if (!address || typeof address === 'string') {
        throw new Error('Expected TCP address');
    }
    return {
        config: {
            host: '127.0.0.1',
            port: address.port,
            secure: false,
            user: 'user',
            pass: 'secret-password',
        },
        messages,
        connections: () => connections,
    };
}
function smtpReply(line: string, mode: string): string {
    if (line.startsWith('EHLO')) {
        return '250-localhost\r\n250 AUTH PLAIN\r\n';
    }
    if (line.startsWith('AUTH')) {
        return mode === 'reject' ? '535 secret-password rejected\r\n' : '235 authenticated\r\n';
    }
    if (line.startsWith('MAIL') && mode === 'reject-mail') {
        return '550 sender rejected\r\n';
    }
    if (line === 'DATA') {
        return '354 send message\r\n';
    }
    if (line === 'QUIT') {
        return '221 bye\r\n';
    }
    return '250 ok\r\n';
}
afterEach(async () => {
    for (const socket of sockets) {
        socket.destroy();
    }
    await Promise.all(
        servers
            .splice(0)
            .map((server) => new Promise<void>((resolve) => server.close(() => resolve()))),
    );
});
async function check(
    transports: SmtpTransportConfig[],
    recipient?: string,
): Promise<DiagnosticReport> {
    const config = parseMagicSsoConfigToml(
        readFileSync(new URL('../magic-sso.example.toml', import.meta.url), 'utf8').replaceAll(
            'replace-me-with',
            'smtp-fixture-with',
        ),
        'test.toml',
    );
    const primary = transports[0];
    if (!primary) {
        throw new Error('Primary SMTP required');
    }
    Object.assign(config, {
        emailSmtpHost: primary.host,
        emailSmtpPort: primary.port,
        emailSmtpSecure: primary.secure,
        emailSmtpUser: primary.user,
        emailSmtpPass: primary.pass,
        emailSmtpFallbacks: transports.slice(1),
    });
    const report: DiagnosticReport = { component: 'server', checks: [] };
    await checkDoctorSmtp(report, config, 150, recipient);
    return report;
}
describe('SMTP diagnostics over real sockets', () => {
    it('keeps the CLI offline until an explicit send flag enables SMTP and one message', async () => {
        const service = await smtp();
        const directory = mkdtempSync(join(tmpdir(), 'doctor-email-'));
        try {
            const path = join(directory, 'server.toml');
            const source = readFileSync(
                new URL('../magic-sso.example.toml', import.meta.url),
                'utf8',
            )
                .replaceAll('replace-me-with', 'email-cli-fixture-with')
                .replace('host = "smtp.example.com"', 'host = "127.0.0.1"')
                .replace('port = 587', `port = ${service.config.port}`);
            writeFileSync(path, source);
            let output = '';
            const io = {
                env: {},
                stdout: {
                    write: (chunk: string): void => {
                        output += chunk;
                    },
                },
            };
            expect(await runServerDoctor({ ...io, argv: ['--config', path, '--json'] })).toBe(0);
            expect(service.connections()).toBe(0);
            output = '';
            expect(
                await runServerDoctor({
                    ...io,
                    argv: [
                        '--config',
                        path,
                        '--json',
                        '--send-test-email',
                        'recipient@example.com',
                    ],
                }),
            ).toBe(0);
            expect(service.connections()).toBe(2);
            expect(service.messages).toHaveLength(1);
            expect(output).not.toContain('smtp-password');
        } finally {
            rmSync(directory, { recursive: true, force: true });
        }
    });
    it('verifies authentication without sending a message', async () => {
        const service = await smtp();
        const report = await check([service.config]);
        expect(report.checks[0]?.status).toBe('pass');
        expect(service.messages).toEqual([]);
    });
    it('reports a degraded fallback without exposing SMTP replies or credentials', async () => {
        const primary = await smtp('reject');
        const fallback = await smtp();
        const report = await check([primary.config, fallback.config]);
        expect(report.checks.map((item) => item.status)).toEqual(['warn', 'pass']);
        expect(JSON.stringify(report)).not.toContain('secret-password');
    });
    it('bounds a stalled greeting and closes the socket', async () => {
        const service = await smtp('stall');
        const start = Date.now();
        const report = await check([service.config]);
        expect(report.checks[0]?.status).toBe('fail');
        expect(Date.now() - start).toBeLessThan(1000);
    });
    it('sends only with an explicit recipient, falling back after a sender rejection', async () => {
        const primary = await smtp('reject-mail');
        const fallback = await smtp();
        const report = await check([primary.config, fallback.config], 'recipient@example.com');
        expect(report.checks.at(-1)?.status).toBe('pass');
        expect(primary.messages).toEqual([]);
        expect(fallback.messages).toHaveLength(1);
        expect(fallback.messages[0]).toContain('Magic Link SSO diagnostic test');
        expect(fallback.messages[0]).not.toContain('token=');
    });
    it('fails when all SMTP transports refuse authentication', async () => {
        const service = await smtp('reject');
        const report = await check([service.config], 'recipient@example.com');
        expect(report.checks.map((item) => item.status)).toEqual(['fail', 'fail']);
        expect(service.messages).toEqual([]);
    });
});
