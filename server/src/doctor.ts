// SPDX-License-Identifier: GPL-3.0-or-later

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
    addDiagnostic,
    checkConfiguration,
    checkDiagnosticPath,
    runDoctorCommand,
    type DiagnosticReport,
    type DoctorArguments,
    type DoctorIo,
} from '@magic-link-sso/config-core/diagnostics';
import { parseMagicSsoConfigToml, readConfigFilePath } from './config.js';
import { checkDoctorBrowserSso } from './doctorBrowserSso.js';
import { checkDoctorSmtp } from './doctorSmtp.js';

async function diagnoseServer(
    args: DoctorArguments,
    env: NodeJS.ProcessEnv,
): Promise<DiagnosticReport> {
    const report: DiagnosticReport = { component: 'server', checks: [] };
    const path = env.MAGICSSO_CONFIG_FILE ?? 'MAGICSSO_CONFIG_FILE';
    const config = checkConfiguration(report, 'config', path, () =>
        parseMagicSsoConfigToml(readFileSync(readConfigFilePath(env), 'utf8'), path),
    );
    if (!config) {
        addDiagnostic(report, {
            id: 'dependencies',
            setting: path,
            status: 'skip',
            message: 'Configuration is required for path and network checks.',
            correction: 'Correct the configuration and rerun doctor.',
        });
        return report;
    }
    if (
        !config.cookieSecure &&
        !['localhost', '127.0.0.1', '[::1]'].includes(new URL(config.appUrl).hostname)
    ) {
        addDiagnostic(report, {
            id: 'cookie.secure',
            setting: 'cookie.secure',
            status: 'warn',
            message: 'Authentication cookies lack Secure outside local development.',
            correction: 'Use HTTPS and cookie.secure=true.',
        });
    }
    if (config.securityState.adapter === 'file') {
        const paths = [
            config.verifyTokenStoreDir,
            config.signInEmailRateLimitStoreDir,
            join(config.verifyTokenStoreDir, 'sessions'),
            join(config.verifyTokenStoreDir, 'otp-challenges'),
        ];
        paths.forEach((directory, index) =>
            checkDiagnosticPath(report, `storage.${index}`, directory, {
                directory: true,
                writable: true,
                optional: true,
            }),
        );
    } else {
        addDiagnostic(report, {
            id: 'storage.redis',
            setting: 'server.securityState.redisUrl',
            status: 'skip',
            message: 'Redis configuration is validated; Redis connectivity is outside doctor v1.',
            correction: 'Verify Redis availability separately.',
        });
    }
    await checkDoctorBrowserSso(report, config, args.online, args.timeoutMs);
    if (args.online || args.recipient) {
        await checkDoctorSmtp(report, config, args.timeoutMs, args.recipient);
    } else {
        addDiagnostic(report, {
            id: 'smtp',
            setting: 'email.smtp',
            status: 'skip',
            message: 'Offline mode; SMTP was not contacted.',
            correction:
                'Use --online to verify SMTP, or --send-test-email <address> to explicitly send a test.',
        });
    }
    return report;
}

export async function runServerDoctor(io: DoctorIo = {}): Promise<number> {
    return runDoctorCommand('server', io, diagnoseServer);
}

if (process.argv[1] !== undefined && fileURLToPath(import.meta.url) === process.argv[1]) {
    // Match server startup's dotenv loading without changing the supplied environment in tests.
    await import('dotenv/config');
    process.exitCode = await runServerDoctor({ argv: process.argv.slice(2) });
}
