// SPDX-License-Identifier: MIT

import { accessSync, constants, statSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { parseArgs } from 'node:util';

export interface DiagnosticCheck {
    id: string;
    status: 'pass' | 'warn' | 'fail' | 'skip';
    setting: string;
    message: string;
    correction: string;
}

export interface DiagnosticReport {
    component: 'server' | 'manager';
    checks: DiagnosticCheck[];
}

export interface DoctorArguments {
    config: string | undefined;
    json: boolean;
    online: boolean;
    timeoutMs: number;
    help: boolean;
    recipient: string | undefined;
}

export interface DoctorIo {
    argv?: readonly string[];
    env?: NodeJS.ProcessEnv;
    stdout?: { write(chunk: string): unknown };
    stderr?: { write(chunk: string): unknown };
}

export function parseDoctorArguments(argv: readonly string[], allowEmail = false): DoctorArguments {
    const emailOptions: Record<string, { type: 'string' }> = allowEmail
        ? { 'send-test-email': { type: 'string' } }
        : {};
    const options: Record<string, { type: 'string' | 'boolean' }> = {
        config: { type: 'string' },
        json: { type: 'boolean' },
        online: { type: 'boolean' },
        help: { type: 'boolean' },
        'timeout-ms': { type: 'string' },
        ...emailOptions,
    };
    const parsed = parseArgs({
        args: [...argv],
        options,
        strict: true,
        allowPositionals: false,
    });
    const timeout = parsed.values['timeout-ms'] ?? '5000';
    if (
        typeof timeout !== 'string' ||
        !/^\d+$/u.test(timeout) ||
        Number(timeout) < 100 ||
        Number(timeout) > 30_000
    ) {
        throw new Error('Use --timeout-ms with an integer from 100 to 30000.');
    }
    const recipient = parsed.values['send-test-email'];
    if (
        recipient !== undefined &&
        (typeof recipient !== 'string' ||
            !/^[^\s<>@,;]+@[^\s<>@,;]+\.[^\s<>@,;]+$/u.test(recipient))
    ) {
        throw new Error('Use --send-test-email with one email address.');
    }
    const config = parsed.values.config;
    if (config !== undefined && (typeof config !== 'string' || !config.trim())) {
        throw new Error('Use --config with a TOML file path.');
    }
    return {
        config: typeof config === 'string' ? config : undefined,
        json: parsed.values.json === true,
        online: parsed.values.online === true,
        help: parsed.values.help === true,
        timeoutMs: Number(timeout),
        recipient: typeof recipient === 'string' ? recipient : undefined,
    };
}

export function addDiagnostic(report: DiagnosticReport, check: DiagnosticCheck): void {
    report.checks.push(check);
}

/** Never include arbitrary parser messages: TOML syntax errors can contain secrets. */
export function checkConfiguration<T>(
    report: DiagnosticReport,
    id: string,
    setting: string,
    load: () => T,
): T | undefined {
    try {
        const value = load();
        addDiagnostic(report, {
            id,
            setting,
            status: 'pass',
            message: 'Configuration is valid.',
            correction: '',
        });
        return value;
    } catch (error: unknown) {
        // Only emit known field names; even a parser message's apparent field can be secret text.
        const fields = [
            'auth.jwtSecret',
            'auth.emailSecret',
            'auth.csrfSecret',
            'auth.previewSecret',
            'auth.otp',
            'server.appUrl',
            'server.reload.secret',
            'server.securityState',
            'cookie.secure',
            'email.smtp',
            'email.from',
            'paths',
            'reload.secret',
            'audit.integrityKey',
            'service.auth',
            'managedSiteIds',
            'sites',
        ];
        const field =
            error instanceof Error
                ? fields.find((name) => error.message.includes(name))
                : undefined;
        addDiagnostic(report, {
            id,
            setting: field ? `${setting}: ${field}` : setting,
            status: 'fail',
            message: 'Cannot read or validate configuration.',
            correction: `Check the file, TOML syntax and documented ${field ?? 'configuration'} settings.`,
        });
        return undefined;
    }
}

function isMissing(error: unknown): boolean {
    return error instanceof Error && 'code' in error && error.code === 'ENOENT';
}

function checkWritableParent(path: string): void {
    let parent = dirname(path);
    for (;;) {
        try {
            if (!statSync(parent).isDirectory()) {
                throw new Error('Not a directory');
            }
            accessSync(parent, constants.W_OK | constants.X_OK);
            return;
        } catch (error: unknown) {
            if (!isMissing(error) || dirname(parent) === parent) {
                throw error;
            }
            parent = dirname(parent);
        }
    }
}

export function checkDiagnosticPath(
    report: DiagnosticReport,
    id: string,
    path: string,
    options: {
        directory?: boolean;
        optional?: boolean;
        writable?: boolean;
        replaceable?: boolean;
    } = {},
): boolean {
    const setting = resolve(path);
    try {
        let missing = false;
        try {
            const stat = statSync(setting);
            if (options.directory ? !stat.isDirectory() : !stat.isFile()) {
                throw new Error('Wrong file type');
            }
            accessSync(
                setting,
                constants.R_OK |
                    (options.directory ? constants.X_OK : 0) |
                    (options.writable ? constants.W_OK : 0),
            );
        } catch (error: unknown) {
            if (!isMissing(error) || !options.optional) {
                throw error;
            }
            missing = true;
        }
        if (missing || options.replaceable) {
            checkWritableParent(setting);
        }
        addDiagnostic(report, {
            id,
            setting,
            status: missing ? 'warn' : 'pass',
            message: missing
                ? 'Not created yet; an accessible writable ancestor exists.'
                : 'Path and required permissions are available.',
            correction: missing
                ? 'The service or manager apply must create this path when needed.'
                : '',
        });
        return !missing;
    } catch {
        addDiagnostic(report, {
            id,
            setting,
            status: 'fail',
            message: 'Path is missing, has the wrong type, or is inaccessible.',
            correction:
                'Correct this path and its file/directory permissions for the service user; atomic replacement also requires a writable parent directory.',
        });
        return false;
    }
}

export async function withDiagnosticTimeout<T>(
    timeoutMs: number,
    operation: (signal: AbortSignal) => Promise<T>,
): Promise<T> {
    const controller = new AbortController();
    let timer: ReturnType<typeof setTimeout> | undefined;
    const deadline = new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => {
            controller.abort();
            reject(new Error('Diagnostic timed out'));
        }, timeoutMs);
    });
    try {
        return await Promise.race([operation(controller.signal), deadline]);
    } finally {
        clearTimeout(timer);
    }
}

export function printDiagnosticReport(
    report: DiagnosticReport,
    json: boolean,
    writer: { write(chunk: string): unknown },
): number {
    writer.write(
        json
            ? `${JSON.stringify(report, null, 2)}\n`
            : `Magic Link SSO ${report.component} doctor\n${report.checks
                  .map(
                      (check) =>
                          `[${check.status}] ${check.id} (${check.setting}): ${check.message}${check.correction ? ` ${check.correction}` : ''}`,
                  )
                  .join('\n')}\n`,
    );
    return report.checks.some((check) => check.status === 'fail') ? 1 : 0;
}

export async function runDoctorCommand(
    component: DiagnosticReport['component'],
    io: DoctorIo,
    diagnose: (args: DoctorArguments, env: NodeJS.ProcessEnv) => Promise<DiagnosticReport>,
): Promise<number> {
    let args: DoctorArguments;
    try {
        args = parseDoctorArguments(io.argv ?? [], component === 'server');
    } catch {
        (io.stderr ?? process.stderr).write(
            'Invalid doctor arguments. Use --help for options; timeout must be 100–30000 ms and the test recipient must be a single email address.\n',
        );
        return 2;
    }
    if (args.help) {
        (io.stdout ?? process.stdout).write(
            `Magic Link SSO ${component} doctor\nOptions: --config <file> --json --online --timeout-ms <100..30000> --help${component === 'server' ? ' --send-test-email <address>' : ''}\nOffline by default. Network checks do not prove email delivery or active configuration.\n`,
        );
        return 0;
    }
    const env = { ...(io.env ?? process.env) };
    if (args.config) {
        env[component === 'server' ? 'MAGICSSO_CONFIG_FILE' : 'MAGICSSO_MANAGER_CONFIG_FILE'] =
            args.config;
    }
    return printDiagnosticReport(await diagnose(args, env), args.json, io.stdout ?? process.stdout);
}
