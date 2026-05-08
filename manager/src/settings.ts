/**
 * manager/src/settings.ts
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
import { dirname, resolve } from 'node:path';
import { parse as parseToml } from 'smol-toml';
import { z } from 'zod';

export const MANAGER_CONFIG_FILE_ENV_VAR_NAME = 'MAGICSSO_MANAGER_CONFIG_FILE';

const DEFAULT_AUDIT_MAX_ARCHIVED_FILES = 4;
const DEFAULT_AUDIT_MAX_FILE_BYTES = 1024 * 1024;
const DEFAULT_RELOAD_TIMEOUT_MS = 5000;
const MIN_SECRET_LENGTH = 32;
const AUDIT_INTEGRITY_KEY_PLACEHOLDER =
    'replace-me-with-a-dedicated-long-random-audit-integrity-key';
const RELOAD_SECRET_PLACEHOLDER = 'replace-me-with-a-dedicated-long-random-reload-secret';

export interface ManagerPaths {
    auditFile: string;
    baseConfigFile: string;
    lastGoodRuntimeConfigFile: string;
    lockFile: string;
    runtimeConfigFile: string;
    stateFile: string;
}

export interface ManagerReloadTarget {
    secret: string;
    timeoutMs: number;
    url: string;
}

export interface ManagerAuditConfig {
    integrityKey: string;
    maxArchivedFiles: number;
    maxFileBytes: number;
}

export interface ManagerBearerTokenAuthConfig {
    bearerToken: string;
    mode?: 'bearer-token' | undefined;
}

export interface ManagerGateHeaderAuthConfig {
    mode: 'gate';
    requiredScope: string;
    requiredSiteId: string;
}

export type ManagerServiceAuthConfig = ManagerBearerTokenAuthConfig | ManagerGateHeaderAuthConfig;

export interface ManagerServiceConfig {
    auth: ManagerServiceAuthConfig;
    host: string;
    port: number;
    trustProxy?: boolean | undefined;
}

export interface ManagerRuntimeSettings {
    audit?: ManagerAuditConfig | undefined;
    configFilePath: string;
    managedSiteIds: string[];
    paths: ManagerPaths;
    reload?: ManagerReloadTarget | undefined;
    service?: ManagerServiceConfig | undefined;
}

const configPathSchema = z.string().trim().min(1, 'Path must not be empty.');
const managedSiteIdSchema = z.string().trim().min(1, 'Managed site IDs must not be empty.');

const rawManagerPathsSchema = z
    .object({
        auditFile: configPathSchema,
        baseConfigFile: configPathSchema,
        lastGoodRuntimeConfigFile: configPathSchema,
        lockFile: configPathSchema,
        runtimeConfigFile: configPathSchema,
        stateFile: configPathSchema,
    })
    .strict();

const rawManagerReloadTargetSchema = z
    .object({
        secret: z
            .string()
            .min(
                MIN_SECRET_LENGTH,
                `reload.secret must be at least ${MIN_SECRET_LENGTH} characters long.`,
            ),
        timeoutMs: z.number().int().positive().default(DEFAULT_RELOAD_TIMEOUT_MS),
        url: z.url(),
    })
    .strict();

const rawManagerAuditSchema = z
    .object({
        integrityKey: z
            .string()
            .min(
                MIN_SECRET_LENGTH,
                `audit.integrityKey must be at least ${MIN_SECRET_LENGTH} characters long.`,
            ),
        maxArchivedFiles: z.number().int().min(1).default(DEFAULT_AUDIT_MAX_ARCHIVED_FILES),
        maxFileBytes: z.number().int().positive().default(DEFAULT_AUDIT_MAX_FILE_BYTES),
    })
    .strict();

const rawManagerBearerTokenAuthSchema = z
    .object({
        mode: z.literal('bearer-token').optional(),
        bearerToken: z
            .string()
            .min(
                MIN_SECRET_LENGTH,
                `service.auth.bearerToken must be at least ${MIN_SECRET_LENGTH} characters long.`,
            ),
    })
    .strict();

const rawManagerGateHeaderAuthSchema = z
    .object({
        mode: z.literal('gate'),
        requiredScope: z.string().trim().min(1, 'service.auth.requiredScope must not be empty.'),
        requiredSiteId: managedSiteIdSchema,
    })
    .strict();

const rawManagerServiceAuthSchema = z.union([
    rawManagerBearerTokenAuthSchema,
    rawManagerGateHeaderAuthSchema,
]);

const rawManagerServiceSchema = z
    .object({
        auth: rawManagerServiceAuthSchema,
        host: z.string().trim().min(1, 'service.host must not be empty.').default('127.0.0.1'),
        port: z.number().int().positive().default(4311),
        trustProxy: z.boolean().default(false),
    })
    .strict();

const rawManagerRuntimeSettingsSchema = z
    .object({
        audit: rawManagerAuditSchema,
        managedSiteIds: z.array(managedSiteIdSchema).default([]),
        paths: rawManagerPathsSchema,
        reload: rawManagerReloadTargetSchema.optional(),
        service: rawManagerServiceSchema.optional(),
    })
    .strict();

interface LoadManagerRuntimeSettingsOptions {
    configFilePath?: string | undefined;
    env?: NodeJS.ProcessEnv | undefined;
}

function formatTomlValidationIssue(issue: z.ZodIssue | undefined): string {
    if (typeof issue === 'undefined') {
        return 'Invalid config.';
    }

    return issue.path.length > 0
        ? `${issue.path.map(String).join('.')}: ${issue.message}`
        : issue.message;
}

function normalizeManagedSiteIds(siteIds: readonly string[]): string[] {
    const normalizedSiteIds = [...siteIds].sort((left, right) => left.localeCompare(right));
    const seenSiteIds = new Set<string>();

    for (const siteId of normalizedSiteIds) {
        if (seenSiteIds.has(siteId)) {
            throw new Error(`Managed site IDs must be unique: ${siteId}`);
        }

        seenSiteIds.add(siteId);
    }

    return normalizedSiteIds;
}

export function assertBootstrapAdminSiteIsNotManaged(settings: ManagerRuntimeSettings): void {
    if (settings.service?.auth.mode !== 'gate') {
        return;
    }

    const bootstrapSiteId = settings.service.auth.requiredSiteId;
    if (settings.managedSiteIds.includes(bootstrapSiteId)) {
        throw new Error(
            `Managed site IDs cannot include the Gate bootstrap admin site (${bootstrapSiteId}). Keep it operator-managed in the base config to avoid lockout.`,
        );
    }
}

export function assertReloadSecretIsNotPlaceholder(settings: ManagerRuntimeSettings): void {
    if (settings.reload?.secret !== RELOAD_SECRET_PLACEHOLDER) {
        return;
    }

    throw new Error(
        'reload.secret must be replaced with a dedicated random secret before starting the manager.',
    );
}

export function assertManagerAuditConfig(
    settings: ManagerRuntimeSettings,
): asserts settings is ManagerRuntimeSettings & { audit: ManagerAuditConfig } {
    if (typeof settings.audit === 'undefined') {
        throw new Error(
            'Manager audit settings are not configured. Add [audit] to MAGICSSO_MANAGER_CONFIG_FILE.',
        );
    }

    if (settings.audit.integrityKey !== AUDIT_INTEGRITY_KEY_PLACEHOLDER) {
        return;
    }

    throw new Error(
        'audit.integrityKey must be replaced with a dedicated random secret before starting the manager.',
    );
}

function resolveConfigPath(configDirectory: string, filePath: string): string {
    return resolve(configDirectory, filePath);
}

function resolveManagerConfigFilePath(options: LoadManagerRuntimeSettingsOptions): string {
    if (typeof options.configFilePath === 'string' && options.configFilePath.trim().length > 0) {
        return resolve(options.configFilePath);
    }

    const env = options.env ?? process.env;
    const configuredPath = env[MANAGER_CONFIG_FILE_ENV_VAR_NAME];
    if (typeof configuredPath !== 'string' || configuredPath.trim().length === 0) {
        throw new Error(
            `${MANAGER_CONFIG_FILE_ENV_VAR_NAME} must point to a manager settings TOML file.`,
        );
    }

    return resolve(configuredPath);
}

export function parseManagerRuntimeSettingsToml(
    fileContents: string,
    configFilePath: string,
): ManagerRuntimeSettings {
    let parsedToml: unknown;
    try {
        parsedToml = parseToml(fileContents);
    } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        throw new Error(
            `Failed to parse ${MANAGER_CONFIG_FILE_ENV_VAR_NAME} (${configFilePath}): ${message}`,
        );
    }

    const parsedSettings = rawManagerRuntimeSettingsSchema.safeParse(parsedToml);
    if (!parsedSettings.success) {
        throw new Error(
            `Failed to validate ${MANAGER_CONFIG_FILE_ENV_VAR_NAME} (${configFilePath}): ${formatTomlValidationIssue(parsedSettings.error.issues[0])}`,
        );
    }

    const configDirectory = dirname(configFilePath);
    const normalizedManagedSiteIds = normalizeManagedSiteIds(parsedSettings.data.managedSiteIds);
    const reload =
        typeof parsedSettings.data.reload === 'undefined'
            ? undefined
            : {
                  secret: parsedSettings.data.reload.secret,
                  timeoutMs: parsedSettings.data.reload.timeoutMs,
                  url: parsedSettings.data.reload.url,
              };
    const audit = {
        integrityKey: parsedSettings.data.audit.integrityKey,
        maxArchivedFiles: parsedSettings.data.audit.maxArchivedFiles,
        maxFileBytes: parsedSettings.data.audit.maxFileBytes,
    };
    const service =
        typeof parsedSettings.data.service === 'undefined'
            ? undefined
            : {
                  auth: { ...parsedSettings.data.service.auth },
                  host: parsedSettings.data.service.host,
                  port: parsedSettings.data.service.port,
                  trustProxy: parsedSettings.data.service.trustProxy,
              };

    const settings = {
        audit,
        configFilePath,
        managedSiteIds: normalizedManagedSiteIds,
        paths: {
            auditFile: resolveConfigPath(configDirectory, parsedSettings.data.paths.auditFile),
            baseConfigFile: resolveConfigPath(
                configDirectory,
                parsedSettings.data.paths.baseConfigFile,
            ),
            lastGoodRuntimeConfigFile: resolveConfigPath(
                configDirectory,
                parsedSettings.data.paths.lastGoodRuntimeConfigFile,
            ),
            lockFile: resolveConfigPath(configDirectory, parsedSettings.data.paths.lockFile),
            runtimeConfigFile: resolveConfigPath(
                configDirectory,
                parsedSettings.data.paths.runtimeConfigFile,
            ),
            stateFile: resolveConfigPath(configDirectory, parsedSettings.data.paths.stateFile),
        },
        reload,
        service,
    };

    assertBootstrapAdminSiteIsNotManaged(settings);
    assertManagerAuditConfig(settings);
    assertReloadSecretIsNotPlaceholder(settings);
    return settings;
}

export function loadManagerRuntimeSettings(
    options: LoadManagerRuntimeSettingsOptions = {},
): ManagerRuntimeSettings {
    const configFilePath = resolveManagerConfigFilePath(options);
    const fileContents = readFileSync(configFilePath, 'utf8');
    return parseManagerRuntimeSettingsToml(fileContents, configFilePath);
}
