// SPDX-License-Identifier: GPL-3.0-or-later

import { readFileSync } from 'node:fs';
import {
    addDiagnostic,
    checkConfiguration,
    checkDiagnosticPath,
    runDoctorCommand,
    withDiagnosticTimeout,
    type DiagnosticReport,
    type DoctorArguments,
    type DoctorIo,
} from '@magic-link-sso/config-core/diagnostics';
import { parseMagicSsoConfigToml, type AppConfig } from '@magic-link-sso/config-core';
import { loadManagerRuntimeSettings, type ManagerRuntimeSettings } from './settings.js';
import { loadManagerStateOrEmpty, buildManagerDiff } from './service.js';
import { buildRuntimePlan } from './runtime.js';
import { loadBaseConfig, selectManagedSites } from './baseConfig.js';
import type { ManagerState } from './state.js';

async function checkReload(
    report: DiagnosticReport,
    settings: ManagerRuntimeSettings,
    args: DoctorArguments,
    fetchImpl: typeof fetch,
): Promise<void> {
    const target = settings.reload;
    if (!target || !args.online) {
        addDiagnostic(report, {
            id: 'reload.connection',
            setting: 'reload',
            status: 'skip',
            message: target
                ? 'Offline mode; reload endpoint was not contacted.'
                : 'No reload target is configured.',
            correction: target
                ? 'Use --online to check reload readiness.'
                : 'Configure [reload] for live access updates.',
        });
        return;
    }
    try {
        const result = await withDiagnosticTimeout(args.timeoutMs, async (signal) => {
            const response = await fetchImpl(target.url, {
                method: 'GET',
                redirect: 'error',
                signal,
                headers: { 'x-magic-sso-reload-secret': target.secret },
            });
            if (response.status === 404 || response.status === 405) {
                await response.body?.cancel();
                return 'legacy';
            }
            if (response.status !== 200) {
                await response.body?.cancel();
                throw new Error('Unexpected HTTP status');
            }
            const body: unknown = await response.json();
            if (
                typeof body !== 'object' ||
                body === null ||
                !('status' in body) ||
                body.status !== 'ok' ||
                !('reloadEnabled' in body) ||
                body.reloadEnabled !== true
            ) {
                throw new Error('Unexpected response');
            }
            return 'ready';
        });
        addDiagnostic(report, {
            id: 'reload.connection',
            setting: 'reload.url',
            status: result === 'ready' ? 'pass' : 'warn',
            message:
                result === 'ready'
                    ? 'Authenticated reload readiness probe succeeded; active grants were not changed.'
                    : 'Readiness probe is unavailable (HTTP 404/405).',
            correction:
                result === 'ready'
                    ? ''
                    : 'Check reload.url and enable reload; upgrade an older server to support the read-only probe.',
        });
    } catch {
        addDiagnostic(report, {
            id: 'reload.connection',
            setting: 'reload.url',
            status: 'fail',
            message: 'Reload readiness failed, timed out, or returned an unexpected response.',
            correction:
                'Check reload.url, reload.secret, server availability and proxy routing. Redirects are not followed.',
        });
    }
}

function checkReloadSecret(
    report: DiagnosticReport,
    settings: ManagerRuntimeSettings,
    config: AppConfig,
    source: string,
): void {
    if (!settings.reload) {
        return;
    }
    const matches = settings.reload.secret === config.reload?.secret;
    addDiagnostic(report, {
        id: `reload.secret.${source}`,
        setting: 'reload.secret / server.reload.secret',
        status: matches ? 'pass' : 'fail',
        message: matches
            ? `Reload secrets match the ${source} configuration.`
            : `Reload secret is absent or differs in the ${source} configuration.`,
        correction: matches
            ? ''
            : 'Configure the same dedicated reload secret in manager and server, then restart if global settings changed.',
    });
}

async function diagnoseManager(
    args: DoctorArguments,
    env: NodeJS.ProcessEnv,
    fetchImpl: typeof fetch,
): Promise<DiagnosticReport> {
    const report: DiagnosticReport = { component: 'manager', checks: [] };
    const settings = checkConfiguration(
        report,
        'config',
        env.MAGICSSO_MANAGER_CONFIG_FILE ?? 'MAGICSSO_MANAGER_CONFIG_FILE',
        () => loadManagerRuntimeSettings({ env }),
    );
    if (!settings) {
        addDiagnostic(report, {
            id: 'dependencies',
            setting: 'config',
            status: 'skip',
            message: 'Settings are required for managed-mode checks.',
            correction: 'Correct the configuration and rerun doctor.',
        });
        return report;
    }
    const paths = settings.paths;
    checkDiagnosticPath(report, 'base.path', paths.baseConfigFile);
    const stateExists = checkDiagnosticPath(report, 'state.path', paths.stateFile, {
        optional: true,
        replaceable: true,
    });
    const runtimeExists = checkDiagnosticPath(report, 'runtime.path', paths.runtimeConfigFile, {
        optional: true,
        replaceable: true,
    });
    const lastGoodExists = checkDiagnosticPath(
        report,
        'last-good.path',
        paths.lastGoodRuntimeConfigFile,
        {
            optional: true,
            replaceable: true,
        },
    );
    checkDiagnosticPath(report, 'audit.path', paths.auditFile, {
        optional: true,
        writable: true,
        replaceable: true,
    });
    checkDiagnosticPath(report, 'lock.path', paths.lockFile, { optional: true, replaceable: true });
    if (lastGoodExists) {
        checkConfiguration(report, 'last-good.config', paths.lastGoodRuntimeConfigFile, () =>
            parseMagicSsoConfigToml(
                readFileSync(paths.lastGoodRuntimeConfigFile, 'utf8'),
                paths.lastGoodRuntimeConfigFile,
            ),
        );
    }
    const state = checkConfiguration(report, 'state', paths.stateFile, () =>
        loadManagerStateOrEmpty(settings),
    );
    checkManagerCandidate(report, settings, state, stateExists, runtimeExists);
    if (runtimeExists) {
        const runtime = checkConfiguration(
            report,
            'runtime.existing',
            paths.runtimeConfigFile,
            () =>
                parseMagicSsoConfigToml(
                    readFileSync(paths.runtimeConfigFile, 'utf8'),
                    paths.runtimeConfigFile,
                ),
        );
        if (runtime) {
            checkReloadSecret(report, settings, runtime, 'runtime');
        }
    }
    await checkReload(report, settings, args, fetchImpl);
    return report;
}

function checkManagerCandidate(
    report: DiagnosticReport,
    settings: ManagerRuntimeSettings,
    state: ManagerState | undefined,
    stateExists: boolean,
    runtimeExists: boolean,
): void {
    const path = settings.paths.baseConfigFile;
    const base = checkConfiguration(report, 'base.config', path, () =>
        parseMagicSsoConfigToml(readFileSync(path, 'utf8'), path),
    );
    if (base) {
        checkReloadSecret(report, settings, base, 'base');
    }
    if (!state || !base) {
        addDiagnostic(report, {
            id: 'runtime.candidate',
            setting: path,
            status: 'skip',
            message: 'Valid base configuration and state are required.',
            correction: 'Correct base config and state JSON.',
        });
        return;
    }
    checkConfiguration(report, 'managed-sites', 'managedSiteIds', () =>
        selectManagedSites(loadBaseConfig(settings), state, settings),
    );
    if (!stateExists) {
        addDiagnostic(report, {
            id: 'runtime.candidate',
            setting: settings.paths.stateFile,
            status: 'skip',
            message: 'Initial manager state has not been saved; no candidate is ready for apply.',
            correction:
                'Initialize grants or reconcile from base, review manager diff, then apply.',
        });
        return;
    }
    const plan = checkConfiguration(report, 'runtime.candidate', path, () =>
        buildRuntimePlan(state, settings),
    );
    if (plan && runtimeExists) {
        checkPendingChanges(report, settings, state);
    }
}

function checkPendingChanges(
    report: DiagnosticReport,
    settings: ManagerRuntimeSettings,
    state: ManagerState,
): void {
    const diff = checkConfiguration(report, 'runtime.diff', settings.paths.runtimeConfigFile, () =>
        buildManagerDiff(state, settings),
    );
    if (!diff) {
        return;
    }
    const pending =
        diff.summary.hasChanges ||
        diff.driftStatus?.baseConfigDrifted ||
        diff.driftStatus?.runtimeConfigDrifted;
    addDiagnostic(report, {
        id: 'runtime.pending',
        setting: settings.paths.runtimeConfigFile,
        status: pending ? 'warn' : 'pass',
        message: pending
            ? 'Saved changes or configuration drift require review; active server state is unverified.'
            : 'No saved access changes detected; active server state is unverified.',
        correction: pending ? 'Review manager diff and reconcile status before apply.' : '',
    });
}

export async function runManagerDoctor(
    io: DoctorIo & { fetchImplementation?: typeof fetch } = {},
): Promise<number> {
    return runDoctorCommand('manager', io, (args, env) =>
        diagnoseManager(args, env, io.fetchImplementation ?? fetch),
    );
}
