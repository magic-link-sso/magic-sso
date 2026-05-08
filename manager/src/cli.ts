#!/usr/bin/env node
/**
 * manager/src/cli.ts
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

import { readFileSync } from 'node:fs';
import { hostname, userInfo } from 'node:os';
import { createInterface } from 'node:readline/promises';
import { parseArgs } from 'node:util';
import { fileURLToPath } from 'node:url';
import { recordManagerMutationAuditEvent } from './audit.js';
import { applyManagerState, type ManagerAuditActor, type ManagerAuditEventKind } from './apply.js';
import { buildRuntimePlan } from './runtime.js';
import { loadManagerRuntimeSettings, MANAGER_CONFIG_FILE_ENV_VAR_NAME } from './settings.js';
import {
    addSiteScope,
    buildManagerDiff,
    buildManagerReconcilePreview,
    buildManagerReconcileStatus,
    exportPortableManagerStateSnapshot,
    getManagedSiteDetails,
    listManagedSites,
    loadManagerStateOrEmpty,
    persistManagerState,
    previewPortableManagerStateImport,
    removeSiteScope,
    revokeSiteGrant,
    updateSiteGrant,
} from './service.js';
import { parsePortableManagerStateSnapshotJson } from './state.js';

interface CliWriter {
    write: (chunk: string) => unknown;
}

export interface RunCliOptions {
    actor?: Parameters<typeof applyManagerState>[2] extends { actor?: infer T } ? T : never;
    argv?: readonly string[] | undefined;
    confirm?: ((message: string) => Promise<boolean>) | undefined;
    env?: NodeJS.ProcessEnv | undefined;
    fetchImplementation?: typeof fetch | undefined;
    isInteractive?: boolean | undefined;
    now?: Date | undefined;
    stderr?: CliWriter | undefined;
    stdout?: CliWriter | undefined;
}

interface OutputOptions {
    asJson: boolean;
    stderr: CliWriter;
    stdout: CliWriter;
}

type CliOptionDefinition = {
    multiple?: boolean | undefined;
    type: 'boolean' | 'string';
};

function writeLine(writer: CliWriter, value = ''): void {
    writer.write(`${value}\n`);
}

function printJson(output: OutputOptions, value: unknown): void {
    writeLine(output.stdout, JSON.stringify(value, null, 2));
}

function printSiteDetails(
    output: OutputOptions,
    siteDetails: ReturnType<typeof getManagedSiteDetails>,
): void {
    if (output.asJson) {
        printJson(output, siteDetails);
        return;
    }

    writeLine(output.stdout, `Site: ${siteDetails.id}`);
    writeLine(output.stdout, `Origins: ${siteDetails.origins.join(', ')}`);
    writeLine(output.stdout, `Redirect URIs: ${siteDetails.allowedRedirectUris.join(', ')}`);
    writeLine(output.stdout, `Scope catalog: ${siteDetails.scopeCatalog.join(', ') || '(empty)'}`);
    if (siteDetails.grants.length === 0) {
        writeLine(output.stdout, 'Grants: (empty)');
        return;
    }

    writeLine(output.stdout, 'Grants:');
    for (const grant of siteDetails.grants) {
        writeLine(
            output.stdout,
            `- ${grant.email}: ${grant.scopes[0] === '*' ? 'full-access' : grant.scopes.join(', ')}`,
        );
    }
}

function printDiff(output: OutputOptions, diffResult: ReturnType<typeof buildManagerDiff>): void {
    if (output.asJson) {
        printJson(output, diffResult);
        return;
    }

    if (!diffResult.summary.hasChanges) {
        writeLine(
            output.stdout,
            `No managed access changes. Current source: ${diffResult.diffSource}.`,
        );
        return;
    }

    writeLine(output.stdout, `Current source: ${diffResult.diffSource}`);
    for (const siteDiff of diffResult.summary.changedSites) {
        writeLine(output.stdout, `Site ${siteDiff.siteId}`);
        for (const email of siteDiff.addedFullAccessEmails) {
            writeLine(output.stdout, `+ full-access ${email}`);
        }
        for (const email of siteDiff.removedFullAccessEmails) {
            writeLine(output.stdout, `- full-access ${email}`);
        }
        for (const grant of siteDiff.addedScopedGrants) {
            writeLine(output.stdout, `+ scoped ${grant.email} [${grant.scopes.join(', ')}]`);
        }
        for (const grant of siteDiff.removedScopedGrants) {
            writeLine(output.stdout, `- scoped ${grant.email} [${grant.scopes.join(', ')}]`);
        }
    }
}

function printManagedSiteDiffSummary(
    output: OutputOptions,
    diffSummary:
        | ReturnType<typeof buildManagerReconcilePreview>['diff']
        | ReturnType<typeof previewPortableManagerStateImport>['diff'],
): void {
    if (!diffSummary.hasChanges) {
        writeLine(output.stdout, 'No managed access changes.');
        return;
    }

    for (const siteDiff of diffSummary.changedSites) {
        writeLine(output.stdout, `Site ${siteDiff.siteId}`);
        for (const email of siteDiff.addedFullAccessEmails) {
            writeLine(output.stdout, `+ full-access ${email}`);
        }
        for (const email of siteDiff.removedFullAccessEmails) {
            writeLine(output.stdout, `- full-access ${email}`);
        }
        for (const grant of siteDiff.addedScopedGrants) {
            writeLine(output.stdout, `+ scoped ${grant.email} [${grant.scopes.join(', ')}]`);
        }
        for (const grant of siteDiff.removedScopedGrants) {
            writeLine(output.stdout, `- scoped ${grant.email} [${grant.scopes.join(', ')}]`);
        }
    }
}

function createCliAuditActor(actor: RunCliOptions['actor']): ManagerAuditActor {
    return (
        actor ?? {
            host: hostname(),
            user: userInfo().username,
        }
    );
}

function persistCliAuditEvent(
    output: OutputOptions,
    state: Parameters<typeof recordManagerMutationAuditEvent>[0],
    settings: Parameters<typeof recordManagerMutationAuditEvent>[1],
    mutation: {
        changedSiteIds: string[];
        kind: Exclude<ManagerAuditEventKind, 'apply-failed' | 'apply-succeeded'>;
        message: string;
    },
    options: RunCliOptions,
): void {
    const result = recordManagerMutationAuditEvent(state, settings, {
        actor: createCliAuditActor(options.actor),
        changedSiteIds: mutation.changedSiteIds,
        kind: mutation.kind,
        message: mutation.message,
        now: options.now,
    });
    writeLine(output.stdout, `Audit persisted: ${result.persisted ? 'yes' : 'no'}`);
}

async function confirmAction(
    isInteractive: boolean,
    confirm: ((message: string) => Promise<boolean>) | undefined,
    message: string,
): Promise<boolean> {
    if (!isInteractive) {
        throw new Error('This command requires --yes when stdin is not interactive.');
    }

    if (typeof confirm === 'function') {
        return confirm(message);
    }

    const readline = createInterface({
        input: process.stdin,
        output: process.stdout,
    });

    try {
        const response = await readline.question(`${message} [y/N] `);
        const normalizedResponse = response.trim().toLowerCase();
        return normalizedResponse === 'y' || normalizedResponse === 'yes';
    } finally {
        readline.close();
    }
}

function parseFlagOptions(
    args: readonly string[],
    options: Record<string, CliOptionDefinition>,
): ReturnType<typeof parseArgs> {
    return parseArgs({
        allowPositionals: true,
        args,
        options,
        strict: true,
    });
}

function normalizeScopes(values: readonly string[] | undefined, fullAccess: boolean): string[] {
    if (fullAccess) {
        if ((values?.length ?? 0) > 0) {
            throw new Error('Use either --full-access or one or more --scope values, not both.');
        }

        return ['*'];
    }

    if ((values?.length ?? 0) === 0) {
        throw new Error('Grant commands require --full-access or at least one --scope.');
    }

    return [...values!];
}

async function handleSitesCommand(
    args: readonly string[],
    output: OutputOptions,
    env: NodeJS.ProcessEnv,
): Promise<number> {
    const command = args[0];
    const settings = loadManagerRuntimeSettings({ env });
    const state = loadManagerStateOrEmpty(settings);
    const parsedArgs = parseFlagOptions(args.slice(1), {
        json: {
            type: 'boolean',
        },
    });
    const nestedOutput = {
        ...output,
        asJson: Boolean(parsedArgs.values.json),
    };

    if (command === 'list') {
        const sites = listManagedSites(state, settings);
        if (nestedOutput.asJson) {
            printJson(nestedOutput, sites);
            return 0;
        }

        for (const site of sites) {
            writeLine(
                nestedOutput.stdout,
                `${site.id} grants=${site.grantCount} scopes=${site.scopeCount}`,
            );
        }
        return 0;
    }

    if (command === 'show') {
        const siteId = parsedArgs.positionals[0];
        if (typeof siteId !== 'string') {
            throw new Error('Usage: manager sites show <siteId> [--json]');
        }

        printSiteDetails(nestedOutput, getManagedSiteDetails(state, settings, siteId));
        return 0;
    }

    throw new Error('Usage: manager sites list [--json] | manager sites show <siteId> [--json]');
}

async function handleAccessCommand(
    args: readonly string[],
    output: OutputOptions,
    env: NodeJS.ProcessEnv,
    isInteractive: boolean,
    confirm: RunCliOptions['confirm'],
    options: RunCliOptions,
): Promise<number> {
    const command = args[0];
    const settings = loadManagerRuntimeSettings({ env });
    const state = loadManagerStateOrEmpty(settings);

    if (command === 'list') {
        const parsedArgs = parseFlagOptions(args.slice(1), {
            json: {
                type: 'boolean',
            },
        });
        const siteId = parsedArgs.positionals[0];
        if (typeof siteId !== 'string') {
            throw new Error('Usage: manager access list <siteId> [--json]');
        }

        const siteDetails = getManagedSiteDetails(state, settings, siteId);
        if (parsedArgs.values.json === true) {
            printJson(output, siteDetails.grants);
            return 0;
        }

        if (siteDetails.grants.length === 0) {
            writeLine(output.stdout, '(empty)');
            return 0;
        }

        for (const grant of siteDetails.grants) {
            writeLine(
                output.stdout,
                `${grant.email} ${grant.scopes[0] === '*' ? 'full-access' : grant.scopes.join(', ')}`,
            );
        }
        return 0;
    }

    if (command === 'grant') {
        const parsedArgs = parseFlagOptions(args.slice(1), {
            'full-access': {
                type: 'boolean',
            },
            scope: {
                multiple: true,
                type: 'string',
            },
        });
        const siteId = parsedArgs.positionals[0];
        const email = parsedArgs.positionals[1];
        if (typeof siteId !== 'string' || typeof email !== 'string') {
            throw new Error(
                'Usage: manager access grant <siteId> <email> (--full-access | --scope <scope>...)',
            );
        }

        const scopeValues = Array.isArray(parsedArgs.values.scope)
            ? parsedArgs.values.scope.filter((value): value is string => typeof value === 'string')
            : undefined;

        const nextState = updateSiteGrant(
            state,
            settings,
            siteId,
            email,
            normalizeScopes(scopeValues, parsedArgs.values['full-access'] === true),
        );
        const persistedState = persistManagerState(settings, nextState);
        persistCliAuditEvent(
            output,
            persistedState,
            settings,
            {
                changedSiteIds: [siteId],
                kind: 'grant-saved',
                message: `Saved grant for ${email.trim().toLowerCase()} on ${siteId}.`,
            },
            options,
        );
        writeLine(output.stdout, `Updated grant for ${email} on ${siteId}.`);
        return 0;
    }

    if (command === 'revoke') {
        const parsedArgs = parseFlagOptions(args.slice(1), {
            yes: {
                type: 'boolean',
            },
        });
        const siteId = parsedArgs.positionals[0];
        const email = parsedArgs.positionals[1];
        if (typeof siteId !== 'string' || typeof email !== 'string') {
            throw new Error('Usage: manager access revoke <siteId> <email> [--yes]');
        }

        const confirmed =
            parsedArgs.values.yes === true
                ? true
                : await confirmAction(
                      isInteractive,
                      confirm,
                      `Revoke access for ${email} on ${siteId}?`,
                  );
        if (!confirmed) {
            throw new Error('Access revoke aborted.');
        }

        const nextState = revokeSiteGrant(state, settings, siteId, email);
        const persistedState = persistManagerState(settings, nextState);
        persistCliAuditEvent(
            output,
            persistedState,
            settings,
            {
                changedSiteIds: [siteId],
                kind: 'grant-revoked',
                message: `Revoked grant for ${email.trim().toLowerCase()} on ${siteId}.`,
            },
            options,
        );
        writeLine(output.stdout, `Revoked access for ${email} on ${siteId}.`);
        return 0;
    }

    throw new Error(
        'Usage: manager access list <siteId> [--json] | manager access grant <siteId> <email> (--full-access | --scope <scope>...) | manager access revoke <siteId> <email> [--yes]',
    );
}

async function handleScopesCommand(
    args: readonly string[],
    output: OutputOptions,
    env: NodeJS.ProcessEnv,
    isInteractive: boolean,
    confirm: RunCliOptions['confirm'],
    options: RunCliOptions,
): Promise<number> {
    const command = args[0];
    const settings = loadManagerRuntimeSettings({ env });
    const state = loadManagerStateOrEmpty(settings);

    if (command === 'list') {
        const parsedArgs = parseFlagOptions(args.slice(1), {
            json: {
                type: 'boolean',
            },
        });
        const siteId = parsedArgs.positionals[0];
        if (typeof siteId !== 'string') {
            throw new Error('Usage: manager scopes list <siteId> [--json]');
        }

        const siteDetails = getManagedSiteDetails(state, settings, siteId);
        if (parsedArgs.values.json === true) {
            printJson(output, siteDetails.scopeCatalog);
            return 0;
        }

        for (const scope of siteDetails.scopeCatalog) {
            writeLine(output.stdout, scope);
        }
        if (siteDetails.scopeCatalog.length === 0) {
            writeLine(output.stdout, '(empty)');
        }
        return 0;
    }

    if (command === 'add') {
        const parsedArgs = parseFlagOptions(args.slice(1), {});
        const siteId = parsedArgs.positionals[0];
        const scope = parsedArgs.positionals[1];
        if (typeof siteId !== 'string' || typeof scope !== 'string') {
            throw new Error('Usage: manager scopes add <siteId> <scope>');
        }

        const nextState = addSiteScope(state, settings, siteId, scope);
        const persistedState = persistManagerState(settings, nextState);
        persistCliAuditEvent(
            output,
            persistedState,
            settings,
            {
                changedSiteIds: [siteId],
                kind: 'scope-added',
                message: `Added scope ${scope.trim()} to ${siteId}.`,
            },
            options,
        );
        writeLine(output.stdout, `Added scope ${scope} to ${siteId}.`);
        return 0;
    }

    if (command === 'remove') {
        const parsedArgs = parseFlagOptions(args.slice(1), {
            yes: {
                type: 'boolean',
            },
        });
        const siteId = parsedArgs.positionals[0];
        const scope = parsedArgs.positionals[1];
        if (typeof siteId !== 'string' || typeof scope !== 'string') {
            throw new Error('Usage: manager scopes remove <siteId> <scope> [--yes]');
        }

        const confirmed =
            parsedArgs.values.yes === true
                ? true
                : await confirmAction(
                      isInteractive,
                      confirm,
                      `Remove scope ${scope} from ${siteId}?`,
                  );
        if (!confirmed) {
            throw new Error('Scope removal aborted.');
        }

        const nextState = removeSiteScope(state, settings, siteId, scope);
        const persistedState = persistManagerState(settings, nextState);
        persistCliAuditEvent(
            output,
            persistedState,
            settings,
            {
                changedSiteIds: [siteId],
                kind: 'scope-removed',
                message: `Removed scope ${scope.trim()} from ${siteId}.`,
            },
            options,
        );
        writeLine(output.stdout, `Removed scope ${scope} from ${siteId}.`);
        return 0;
    }

    throw new Error(
        'Usage: manager scopes list <siteId> [--json] | manager scopes add <siteId> <scope> | manager scopes remove <siteId> <scope> [--yes]',
    );
}

async function handleDiffCommand(
    args: readonly string[],
    output: OutputOptions,
    env: NodeJS.ProcessEnv,
): Promise<number> {
    const parsedArgs = parseFlagOptions(args, {
        json: {
            type: 'boolean',
        },
    });
    const settings = loadManagerRuntimeSettings({ env });
    const state = loadManagerStateOrEmpty(settings);
    printDiff(
        {
            ...output,
            asJson: Boolean(parsedArgs.values.json),
        },
        buildManagerDiff(state, settings),
    );
    return 0;
}

async function handleExportCommand(
    args: readonly string[],
    output: OutputOptions,
    env: NodeJS.ProcessEnv,
): Promise<number> {
    parseFlagOptions(args, {
        json: {
            type: 'boolean',
        },
    });
    const settings = loadManagerRuntimeSettings({ env });
    const state = loadManagerStateOrEmpty(settings);
    printJson(output, exportPortableManagerStateSnapshot(state));
    return 0;
}

async function handleImportCommand(
    args: readonly string[],
    output: OutputOptions,
    options: RunCliOptions,
    isInteractive: boolean,
): Promise<number> {
    const parsedArgs = parseFlagOptions(args, {
        yes: {
            type: 'boolean',
        },
    });
    const filePath = parsedArgs.positionals[0];
    if (typeof filePath !== 'string') {
        throw new Error('Usage: manager import <file> [--yes]');
    }

    const settings = loadManagerRuntimeSettings({ env: options.env });
    const state = loadManagerStateOrEmpty(settings);
    const snapshot = parsePortableManagerStateSnapshotJson(
        readFileSync(filePath, 'utf8'),
        filePath,
    );
    const preview = previewPortableManagerStateImport(state, settings, snapshot);
    writeLine(output.stdout, `Import source: ${filePath}`);
    printManagedSiteDiffSummary(output, preview.diff);

    const confirmed =
        parsedArgs.values.yes === true
            ? true
            : await confirmAction(
                  isInteractive,
                  options.confirm,
                  `Replace manager state from ${filePath}?`,
              );
    if (!confirmed) {
        throw new Error('State import aborted.');
    }

    const persistedState = persistManagerState(settings, preview.state);
    writeLine(output.stdout, `Imported portable manager state from ${filePath}.`);
    persistCliAuditEvent(
        output,
        persistedState,
        settings,
        {
            changedSiteIds: preview.changedSiteIds,
            kind: 'state-imported',
            message: `Imported portable manager state from ${filePath}.`,
        },
        options,
    );
    return 0;
}

async function handleReconcileCommand(
    args: readonly string[],
    output: OutputOptions,
    options: RunCliOptions,
    isInteractive: boolean,
): Promise<number> {
    const command = args[0];
    const settings = loadManagerRuntimeSettings({ env: options.env });
    const state = loadManagerStateOrEmpty(settings);

    if (command === 'status') {
        const parsedArgs = parseFlagOptions(args.slice(1), {
            json: {
                type: 'boolean',
            },
        });
        const status = buildManagerReconcileStatus(state, settings);
        if (parsedArgs.values.json === true) {
            printJson(output, status);
            return 0;
        }

        writeLine(
            output.stdout,
            `Drift: ${typeof status.driftStatus === 'undefined' ? 'not established yet' : JSON.stringify(status.driftStatus)}`,
        );
        for (const entry of [status.base, status.runtime]) {
            writeLine(output.stdout, `Source: ${entry.source}`);
            if (!entry.available) {
                writeLine(output.stdout, `Error: ${entry.error ?? 'unknown error'}`);
                continue;
            }

            if (typeof entry.preview === 'undefined') {
                writeLine(output.stdout, 'No preview available.');
                continue;
            }

            printManagedSiteDiffSummary(output, entry.preview.diff);
        }
        return 0;
    }

    if (command !== 'base' && command !== 'runtime') {
        throw new Error(
            'Usage: manager reconcile status [--json] | manager reconcile <base|runtime> [--yes]',
        );
    }

    const parsedArgs = parseFlagOptions(args.slice(1), {
        yes: {
            type: 'boolean',
        },
    });
    const preview = buildManagerReconcilePreview(state, settings, command);
    writeLine(output.stdout, `Reconcile source: ${command}`);
    printManagedSiteDiffSummary(output, preview.diff);

    const confirmed =
        parsedArgs.values.yes === true
            ? true
            : await confirmAction(
                  isInteractive,
                  options.confirm,
                  `Replace manager state from the ${command} config?`,
              );
    if (!confirmed) {
        throw new Error('Reconciliation aborted.');
    }

    const persistedState = persistManagerState(settings, preview.state);
    writeLine(output.stdout, `Reconciled manager state from the ${command} config.`);
    persistCliAuditEvent(
        output,
        persistedState,
        settings,
        {
            changedSiteIds: preview.changedSiteIds,
            kind: 'state-reconciled',
            message: `Reconciled manager state from the ${command} config.`,
        },
        options,
    );
    return 0;
}

async function handleValidateCommand(
    args: readonly string[],
    output: OutputOptions,
    env: NodeJS.ProcessEnv,
): Promise<number> {
    const parsedArgs = parseFlagOptions(args, {
        json: {
            type: 'boolean',
        },
    });
    const settings = loadManagerRuntimeSettings({ env });
    const state = loadManagerStateOrEmpty(settings);
    const runtimePlan = buildRuntimePlan(state, settings);
    const driftStatus =
        typeof state.metadata.lastAppliedBaseConfigHash === 'string' &&
        typeof state.metadata.lastAppliedRuntimeConfigHash === 'string'
            ? buildManagerDiff(state, settings).driftStatus
            : undefined;
    const result = {
        driftStatus,
        runtimeConfigFile: settings.paths.runtimeConfigFile,
        runtimeConfigHash: runtimePlan.runtimeConfigHash,
        valid: true,
    };

    if (parsedArgs.values.json === true) {
        printJson(output, result);
        return 0;
    }

    writeLine(output.stdout, 'Candidate runtime config is valid.');
    writeLine(output.stdout, `Runtime file: ${result.runtimeConfigFile}`);
    writeLine(output.stdout, `Runtime hash: ${result.runtimeConfigHash}`);
    writeLine(
        output.stdout,
        `Drift: ${typeof driftStatus === 'undefined' ? 'not established yet' : JSON.stringify(driftStatus)}`,
    );
    return 0;
}

async function handleApplyCommand(
    args: readonly string[],
    output: OutputOptions,
    options: RunCliOptions,
    isInteractive: boolean,
): Promise<number> {
    const parsedArgs = parseFlagOptions(args, {
        yes: {
            type: 'boolean',
        },
    });
    const settings = loadManagerRuntimeSettings({ env: options.env });
    const state = loadManagerStateOrEmpty(settings);
    const diffResult = buildManagerDiff(state, settings);
    printDiff(output, diffResult);

    const confirmed =
        parsedArgs.values.yes === true
            ? true
            : await confirmAction(
                  isInteractive,
                  options.confirm,
                  'Apply the rendered runtime config?',
              );
    if (!confirmed) {
        throw new Error('Apply aborted.');
    }

    const result = await applyManagerState(state, settings, {
        actor: options.actor,
        fetchImplementation: options.fetchImplementation,
        now: options.now,
    });
    writeLine(output.stdout, result.auditEvent.message);
    writeLine(output.stdout, `Audit persisted: ${result.auditPersisted ? 'yes' : 'no'}`);
    return 0;
}

export async function runCli(options: RunCliOptions = {}): Promise<number> {
    const argv = [...(options.argv ?? process.argv.slice(2))];
    const stdout = options.stdout ?? process.stdout;
    const stderr = options.stderr ?? process.stderr;
    const env = options.env ?? process.env;
    const isInteractive = options.isInteractive ?? Boolean(process.stdin.isTTY);
    const output: OutputOptions = {
        asJson: false,
        stderr,
        stdout,
    };

    if (argv.length === 0) {
        writeLine(
            stderr,
            `Usage: manager <sites|access|scopes|export|import|reconcile|diff|validate|apply> ...\nSet ${MANAGER_CONFIG_FILE_ENV_VAR_NAME} to the manager settings file.`,
        );
        return 1;
    }

    try {
        const [command, ...rest] = argv;
        switch (command) {
            case 'sites':
                return await handleSitesCommand(rest, output, env);
            case 'access':
                return await handleAccessCommand(
                    rest,
                    output,
                    env,
                    isInteractive,
                    options.confirm,
                    options,
                );
            case 'scopes':
                return await handleScopesCommand(
                    rest,
                    output,
                    env,
                    isInteractive,
                    options.confirm,
                    options,
                );
            case 'export':
                return await handleExportCommand(rest, output, env);
            case 'import':
                return await handleImportCommand(rest, output, options, isInteractive);
            case 'reconcile':
                return await handleReconcileCommand(rest, output, options, isInteractive);
            case 'diff':
                return await handleDiffCommand(rest, output, env);
            case 'validate':
                return await handleValidateCommand(rest, output, env);
            case 'apply':
                return await handleApplyCommand(rest, output, { ...options, env }, isInteractive);
            default:
                throw new Error(`Unknown command: ${command}`);
        }
    } catch (error) {
        writeLine(stderr, error instanceof Error ? error.message : String(error));
        return 1;
    }
}

if (process.argv[1] !== undefined && fileURLToPath(import.meta.url) === process.argv[1]) {
    void runCli().then((exitCode) => {
        process.exitCode = exitCode;
    });
}
