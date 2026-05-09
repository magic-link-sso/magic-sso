import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { tmpdir } from 'node:os';
import type { FastifyInstance } from 'fastify';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
    FULL_ACCESS_SCOPE,
    loadConfig as loadCoreConfig,
    type AppConfig,
} from '../packages/config-core/src/index.js';
import {
    addSiteScope,
    applyManagerState,
    buildRuntimePlan,
    loadManagerRuntimeSettings,
    loadManagerStateOrEmpty,
    persistManagerState,
    updateSiteGrant,
} from '../manager/src/index.js';
import { buildApp } from '../server/src/app.js';
import * as serverConfigModule from '../server/src/config.js';
import type { VerificationEmailInput, VerificationEmailSender } from '../server/src/email.js';
import type { PerEmailSignInLimiter } from '../server/src/perEmailSignInLimiter.js';

const tempDirectories: string[] = [];

function createBaseConfigToml(): string {
    return `
[auth]
jwtSecret = "jwt-secret-0123456789-0123456789"
csrfSecret = "csrf-secret-0123456789-012345678"
emailSecret = "email-secret-0123456789-01234567"
previewSecret = "preview-secret-0123456789-0123456"

[email]
from = "owner@example.com"

[email.smtp]
host = "smtp.example.com"
user = "smtp-user"
pass = "smtp-password"

[server.reload]
secret = "reload-secret-0123456789-0123456789"

[[sites]]
id = "client"
origins = ["http://client.example.com"]
allowedRedirectUris = ["http://client.example.com/*"]
allowedEmails = ["legacy-admin@example.com"]
    `.trimStart();
}

function createManagerSettingsToml(): string {
    return `
	managedSiteIds = ["client"]

	[audit]
	integrityKey = "manager-audit-integrity-key-0123456789abcdefghij"
	maxArchivedFiles = 4
	maxFileBytes = 1048576

	[paths]
	baseConfigFile = "./magic-sso.base.toml"
stateFile = "./manager-state.json"
runtimeConfigFile = "./magic-sso.runtime.toml"
lastGoodRuntimeConfigFile = "./magic-sso.runtime.last-good.toml"
auditFile = "./manager-audit.ndjson"
lockFile = "./manager.lock"

[reload]
url = "http://127.0.0.1:4310/internal/access-config/reload"
secret = "reload-secret-0123456789-0123456789"
timeoutMs = 2000
    `.trimStart();
}

function createInjectFetch(app: FastifyInstance): typeof fetch {
    const injectFetch: typeof fetch = async (input, init) => {
        const requestUrl =
            typeof input === 'string' || input instanceof URL
                ? new URL(input.toString())
                : new URL(input.url);
        const headers = new Headers(
            init?.headers ?? (input instanceof Request ? input.headers : undefined),
        );
        let payload: string | undefined;
        if (typeof init?.body === 'string') {
            payload = init.body;
        } else if (typeof init?.body !== 'undefined' && init.body !== null) {
            throw new Error('Unsupported fetch body type in integration test.');
        }
        if (typeof payload === 'undefined') {
            headers.delete('content-type');
        }

        const response = await app.inject({
            headers: Object.fromEntries(headers.entries()),
            method: init?.method ?? (input instanceof Request ? input.method : 'GET'),
            payload,
            url: `${requestUrl.pathname}${requestUrl.search}`,
        });

        return new Response(response.body, {
            headers: response.headers as HeadersInit,
            status: response.statusCode,
        });
    };

    return injectFetch;
}

async function attemptScopedSignin(
    app: FastifyInstance,
    sentEmails: VerificationEmailInput[],
    email: string,
    scope: string,
): Promise<number> {
    const beforeCount = sentEmails.length;
    const response = await app.inject({
        method: 'POST',
        url: '/signin',
        headers: {
            'content-type': 'application/json',
        },
        payload: {
            email,
            returnUrl: 'http://client.example.com/protected/reports',
            scope,
        },
    });

    expect(response.statusCode).toBe(200);
    return sentEmails.length - beforeCount;
}

describe('manager and server integration', () => {
    afterEach(async () => {
        vi.restoreAllMocks();

        await Promise.all(
            tempDirectories.splice(0).map(async (directory) => {
                await rm(directory, { force: true, recursive: true });
            }),
        );
    });

    it('applies manager state and reloads scoped access without restarting the server', async () => {
        const tempDirectory = await mkdtemp(path.join(tmpdir(), 'magic-sso-manager-server-'));
        tempDirectories.push(tempDirectory);

        const baseConfigFilePath = path.join(tempDirectory, 'magic-sso.base.toml');
        const managerConfigFilePath = path.join(tempDirectory, 'manager.toml');

        await writeFile(baseConfigFilePath, createBaseConfigToml(), 'utf8');
        await writeFile(managerConfigFilePath, createManagerSettingsToml(), 'utf8');

        const settings = loadManagerRuntimeSettings({
            env: {
                MAGICSSO_MANAGER_CONFIG_FILE: managerConfigFilePath,
            },
        });

        const initialState = updateSiteGrant(
            loadManagerStateOrEmpty(settings),
            settings,
            'client',
            'legacy-admin@example.com',
            [FULL_ACCESS_SCOPE],
        );
        persistManagerState(settings, initialState);
        const initialRuntimePlan = buildRuntimePlan(initialState, settings);
        await writeFile(settings.paths.runtimeConfigFile, initialRuntimePlan.runtimeToml, 'utf8');

        const sentEmails: VerificationEmailInput[] = [];
        const mailer: VerificationEmailSender = {
            async sendVerificationEmail(input: VerificationEmailInput): Promise<void> {
                sentEmails.push(input);
            },
        };
        const perEmailSignInLimiter: PerEmailSignInLimiter = {
            async consume(): Promise<{ allowed: true; retryAfterSeconds: 0 }> {
                return {
                    allowed: true,
                    retryAfterSeconds: 0,
                };
            },
        };
        const loadConfigSpy = vi.spyOn(serverConfigModule, 'loadConfig').mockImplementation(
            (_env?: NodeJS.ProcessEnv): AppConfig =>
                loadCoreConfig({
                    MAGICSSO_CONFIG_FILE: settings.paths.runtimeConfigFile,
                }),
        );

        const app = await buildApp({
            config: loadCoreConfig({
                MAGICSSO_CONFIG_FILE: settings.paths.runtimeConfigFile,
            }),
            logger: false,
            mailer,
            perEmailSignInLimiter,
        });

        try {
            expect(
                await attemptScopedSignin(app, sentEmails, 'reports@example.com', 'reports'),
            ).toBe(0);

            let nextState = loadManagerStateOrEmpty(settings);
            nextState = addSiteScope(nextState, settings, 'client', 'reports');
            nextState = updateSiteGrant(nextState, settings, 'client', 'reports@example.com', [
                'reports',
            ]);
            persistManagerState(settings, nextState);

            const applyResult = await applyManagerState(nextState, settings, {
                fetchImplementation: createInjectFetch(app),
                now: new Date('2026-05-02T15:45:00.000Z'),
            });

            expect(loadConfigSpy).toHaveBeenCalled();
            expect(applyResult.reloadResult).toEqual({
                changedSiteIds: ['client'],
                reloaded: true,
            });
            expect(await readFile(settings.paths.runtimeConfigFile, 'utf8')).toContain(
                'scopes = [ "reports" ]',
            );
            expect(
                await attemptScopedSignin(app, sentEmails, 'reports@example.com', 'reports'),
            ).toBe(1);
            expect(sentEmails.at(-1)?.email).toBe('reports@example.com');
            expect(await readFile(settings.paths.auditFile, 'utf8')).toContain('apply-succeeded');
        } finally {
            await app.close();
        }
    });
});
