import { defineConfig } from '@playwright/test';

import { mkdtempSync, readFileSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { writeStarter } from '../../scripts/setup.mjs';

type TestConfigWebServer = Exclude<
    ReturnType<typeof defineConfig>['webServer'],
    undefined | unknown[]
>;

const packageDir = dirname(fileURLToPath(import.meta.url));
const quietWebServerScript = resolve(packageDir, 'src/run-web-server.mjs');
const repoRoot = resolve(packageDir, '../..');
const angularPort = '43104';
const fastifyPort = '43105';
const photosPort = '5001';
const managerGatePort = '43111';
const managerServicePort = '43110';
const private1GatePort = '43106';
const private1UpstreamPort = '43107';
const private2UpstreamPort = '43108';
const private2GatePort = '43109';
const djangoPort = '43103';
const mailSinkHttpPort = '43126';
const mailSinkSmtpPort = '43125';
const nextPort = '43101';
const nuxtPort = '43102';
const serverPort = '43100';
const serverFixtureConfigPath = resolve(packageDir, 'fixtures/server.config.toml');
const managerReloadSecret = 'test-manager-reload-secret-1234567890';
const sharedJwtSecret = 'test-jwt-secret-for-e2e-suite-123456';
const sharedPreviewSecret = 'test-preview-secret-for-e2e-suite-123';
const gracefulWebServerShutdown: { signal: 'SIGTERM'; timeout: number } = {
    signal: 'SIGTERM',
    timeout: 5_000,
};

function createEphemeralServerConfigPath(): string {
    const tempDir = mkdtempSync(join(tmpdir(), 'magic-sso-e2e-server-'));
    const verifyTokenStoreDir = resolve(tempDir, 'verification-tokens');
    const signInEmailRateLimitStoreDir = resolve(tempDir, 'signin-email-rate-limit');
    const configContents = `${readFileSync(serverFixtureConfigPath, 'utf8').replace(
        'logLevel = "error"',
        `logLevel = "error"\nverifyTokenStoreDir = "${verifyTokenStoreDir}"\nsignInEmailRateLimitStoreDir = "${signInEmailRateLimitStoreDir}"\n[rateLimit]\nsignInMax = 100\nsignInEmailMax = 50\nsignInPageMax = 500\nverifyMax = 100`,
    )}

[auth.otp]
enabled = true
secret = "test-otp-secret-for-e2e-suite-1234567890"
length = 6
expiration = "5m"
allowedAttempts = 3
resendStrategy = "rotate"
`;
    const configPath = resolve(tempDir, 'server.config.toml');
    writeFileSync(configPath, configContents, 'utf8');
    return configPath;
}

function createEphemeralManagerServerConfigPath(): string {
    const tempDir = mkdtempSync(join(tmpdir(), 'magic-sso-e2e-manager-server-'));
    const verifyTokenStoreDir = resolve(tempDir, 'verification-tokens');
    const signInEmailRateLimitStoreDir = resolve(tempDir, 'signin-email-rate-limit');
    const configPath = resolve(tempDir, 'server.config.toml');
    const configContents = `
[server]
appPort = ${serverPort}
appUrl = "http://localhost:${serverPort}"
logLevel = "error"
verifyTokenStoreDir = "${verifyTokenStoreDir}"
signInEmailRateLimitStoreDir = "${signInEmailRateLimitStoreDir}"

[server.reload]
secret = "${managerReloadSecret}"

[auth]
csrfSecret = "test-csrf-secret-for-manager-e2e-suite-123456"
jwtSecret = "${sharedJwtSecret}"
emailSecret = "test-email-secret-for-manager-e2e-suite-12345"
previewSecret = "${sharedPreviewSecret}"

[cookie]
name = "magic-sso"
secure = false

[email]
from = "noreply@example.com"

[email.smtp]
host = "127.0.0.1"
port = 43125
user = "test-user"
pass = "test-password"
secure = false

[[sites]]
id = "photos"
origins = ["http://localhost:${photosPort}"]
allowedRedirectUris = ["http://localhost:${photosPort}/verify-email", "http://localhost:${photosPort}/*"]
allowedEmails = ["owner@example.com", "friend@example.com", "family@example.com"]

[sites.hostedAuth.branding]
title = "Magic Link SSO Photos Demo"
logoText = "PH"

[[sites]]
id = "archive"
origins = ["http://localhost:5002"]
allowedRedirectUris = ["http://localhost:5002/verify-email"]
allowedEmails = []

[[sites]]
id = "manager-admin"
origins = ["http://localhost:${managerGatePort}"]
allowedRedirectUris = ["http://localhost:${managerGatePort}/_magicgate/verify-email", "http://localhost:${managerGatePort}/*"]
allowedEmails = ["manager@example.com"]

[sites.hostedAuth.branding]
title = "Magic Link SSO Manager"
logoText = "MG"
`.trimStart();
    writeFileSync(configPath, configContents, 'utf8');
    return configPath;
}

function createEphemeralManagerSettingsPaths(): {
    bootstrapConfigPath: string;
    configPath: string;
    runtimeConfigFile: string;
} {
    const tempDir = mkdtempSync(join(tmpdir(), 'magic-sso-e2e-manager-settings-'));
    const baseConfigFile = resolve(tempDir, 'magic-sso.base.toml');
    const bootstrapConfigPath = resolve(tempDir, 'manager.bootstrap.toml');
    const configPath = resolve(tempDir, 'manager.toml');
    const stateFile = resolve(tempDir, 'manager-state.json');
    const runtimeConfigFile = resolve(tempDir, 'magic-sso.runtime.toml');
    const lastGoodRuntimeConfigFile = resolve(tempDir, 'magic-sso.runtime.last-good.toml');
    const auditFile = resolve(tempDir, 'manager-audit.ndjson');
    const lockFile = resolve(tempDir, 'manager.lock');

    writeFileSync(
        baseConfigFile,
        readFileSync(createEphemeralManagerServerConfigPath(), 'utf8'),
        'utf8',
    );
    writeFileSync(
        stateFile,
        JSON.stringify(
            {
                version: 1,
                managedSites: {
                    archive: { grants: [], scopeCatalog: ['read'] },
                    photos: {
                        grants: [
                            {
                                email: 'owner@example.com',
                                scopes: ['*'],
                            },
                            {
                                email: 'friend@example.com',
                                scopes: ['friends'],
                            },
                            {
                                email: 'family@example.com',
                                scopes: ['family'],
                            },
                        ],
                        scopeCatalog: ['friends', 'family', 'photo:red-kite-at-dusk'],
                    },
                },
                metadata: {},
            },
            null,
            2,
        ),
        'utf8',
    );
    writeFileSync(
        bootstrapConfigPath,
        `
managedSiteIds = ["photos", "archive"]

[audit]
integrityKey = "test-manager-audit-integrity-key-1234567890"

[paths]
baseConfigFile = "${baseConfigFile}"
stateFile = "${stateFile}"
runtimeConfigFile = "${runtimeConfigFile}"
lastGoodRuntimeConfigFile = "${lastGoodRuntimeConfigFile}"
auditFile = "${auditFile}"
lockFile = "${lockFile}"
`.trimStart(),
        'utf8',
    );
    writeFileSync(
        configPath,
        `
managedSiteIds = ["photos", "archive"]

[audit]
integrityKey = "test-manager-audit-integrity-key-1234567890"

[paths]
baseConfigFile = "${baseConfigFile}"
stateFile = "${stateFile}"
runtimeConfigFile = "${runtimeConfigFile}"
lastGoodRuntimeConfigFile = "${lastGoodRuntimeConfigFile}"
auditFile = "${auditFile}"
lockFile = "${lockFile}"

[reload]
url = "http://127.0.0.1:${serverPort}/internal/access-config/reload"
secret = "${managerReloadSecret}"
timeoutMs = 5000

[service]
host = "127.0.0.1"
port = ${managerServicePort}
trustProxy = true

[service.auth]
mode = "gate"
requiredSiteId = "manager-admin"
requiredScope = "*"
`.trimStart(),
        'utf8',
    );

    return {
        bootstrapConfigPath,
        configPath,
        runtimeConfigFile,
    };
}

function createEphemeralGateConfigPath(options: {
    directUse: boolean;
    port: string;
    publicOrigin: string;
    upstreamUrl: string;
    trustProxy?: boolean;
}): string {
    const tempDir = mkdtempSync(join(tmpdir(), 'magic-sso-e2e-gate-'));
    const configPath = resolve(tempDir, 'magic-gate.toml');
    const configContents = `
[gate]
port = ${options.port}
mode = "subdomain"
namespace = "/_magicgate"
publicOrigin = "${options.publicOrigin}"
upstreamUrl = "${options.upstreamUrl}"
directUse = ${options.directUse ? 'true' : 'false'}
requestTimeoutMs = 10000
rateLimitMax = 240
rateLimitWindowMs = 60000
trustProxy = ${options.trustProxy === true ? 'true' : 'false'}
wsEnabled = true

[auth]
serverUrl = "http://localhost:${serverPort}"
jwtSecret = "${sharedJwtSecret}"
previewSecret = "${sharedPreviewSecret}"

[cookie]
name = "magic-sso"
path = "/"
maxAge = 3600
`.trimStart();

    writeFileSync(configPath, configContents, 'utf8');
    return configPath;
}

function parseOptionalPositiveInteger(value: string | undefined): number | undefined {
    if (typeof value !== 'string' || value.trim().length === 0) {
        return undefined;
    }

    const parsedValue = Number.parseInt(value, 10);
    if (!Number.isFinite(parsedValue) || parsedValue <= 0) {
        throw new Error('PW_SLOWMO_MS must be a positive integer.');
    }

    return parsedValue;
}

function buildEnv(overrides: Record<string, string>): Record<string, string> {
    const baseEnv = Object.fromEntries(
        Object.entries(process.env).filter(
            (entry): entry is [string, string] => typeof entry[1] === 'string',
        ),
    );
    delete baseEnv['FORCE_COLOR'];
    delete baseEnv['NO_COLOR'];

    return {
        ...baseEnv,
        ...overrides,
    };
}

export function createE2eConfig(
    options: Readonly<{
        directUse: boolean;
        behindProxy?: boolean;
        testMatch: RegExp;
    }>,
): ReturnType<typeof defineConfig> {
    const listenPort = (port: string): string =>
        options.behindProxy ? String(Number(port) + 100) : port;
    const isCi = process.env.CI === 'true';
    const slowMo = parseOptionalPositiveInteger(process.env.PW_SLOWMO_MS);
    const directUse = options.directUse;
    const directUseEnv = directUse ? 'true' : 'false';
    const serverConfigPath = createEphemeralServerConfigPath();

    const serverEnv = buildEnv({
        MAGICSSO_CONFIG_FILE: serverConfigPath,
    });

    const nextEnv = buildEnv({
        MAGICSSO_TRUST_PROXY: options.behindProxy ? 'true' : 'false',
        MAGICSSO_COOKIE_NAME: 'magic-sso',
        MAGICSSO_COOKIE_MAX_AGE: '3600',
        MAGICSSO_DIRECT_USE: directUseEnv,
        MAGICSSO_JWT_SECRET: sharedJwtSecret,
        MAGICSSO_PREVIEW_SECRET: sharedPreviewSecret,
        MAGICSSO_PUBLIC_ORIGIN: options.behindProxy ? '' : `http://localhost:${nextPort}`,
        MAGICSSO_SERVER_URL: `http://localhost:${serverPort}`,
    });

    const nuxtEnv = buildEnv({
        MAGICSSO_TRUST_PROXY: options.behindProxy ? 'true' : 'false',
        MAGICSSO_AUTH_EVERYWHERE: 'true',
        APP_URL: `http://localhost:${nuxtPort}`,
        MAGICSSO_COOKIE_NAME: 'magic-sso',
        MAGICSSO_COOKIE_MAX_AGE: '3600',
        MAGICSSO_DIRECT_USE: directUseEnv,
        MAGICSSO_JWT_SECRET: sharedJwtSecret,
        MAGICSSO_PREVIEW_SECRET: sharedPreviewSecret,
        MAGICSSO_PUBLIC_ORIGIN: options.behindProxy ? '' : `http://localhost:${nuxtPort}`,
        MAGICSSO_SERVER_URL: `http://localhost:${serverPort}`,
    });

    const djangoEnv = buildEnv({
        MAGICSSO_AUTH_EVERYWHERE: 'true',
        MAGICSSO_COOKIE_NAME: 'magic-sso',
        MAGICSSO_COOKIE_SAMESITE: 'Lax',
        MAGICSSO_COOKIE_SECURE: 'true',
        MAGICSSO_DIRECT_USE: directUseEnv,
        MAGICSSO_JWT_SECRET: sharedJwtSecret,
        MAGICSSO_PREVIEW_SECRET: sharedPreviewSecret,
        MAGICSSO_SERVER_URL: `http://localhost:${serverPort}`,
        PYTHONUNBUFFERED: '1',
    });

    const angularEnv = buildEnv({
        MAGICSSO_COOKIE_NAME: 'magic-sso',
        MAGICSSO_COOKIE_MAX_AGE: '3600',
        MAGICSSO_DIRECT_USE: directUseEnv,
        MAGICSSO_JWT_SECRET: sharedJwtSecret,
        MAGICSSO_PREVIEW_SECRET: sharedPreviewSecret,
        MAGICSSO_SERVER_URL: `http://localhost:${serverPort}`,
        PORT: listenPort(angularPort),
    });

    const fastifyEnv = buildEnv({
        MAGICSSO_COOKIE_NAME: 'magic-sso',
        MAGICSSO_COOKIE_MAX_AGE: '3600',
        MAGICSSO_DIRECT_USE: directUseEnv,
        MAGICSSO_JWT_SECRET: sharedJwtSecret,
        MAGICSSO_PREVIEW_SECRET: sharedPreviewSecret,
        MAGICSSO_SERVER_URL: `http://localhost:${serverPort}`,
        PORT: listenPort(fastifyPort),
    });

    const private1GateConfigPath = createEphemeralGateConfigPath({
        directUse,
        port: listenPort(private1GatePort),
        trustProxy: options.behindProxy === true,
        publicOrigin: `http://localhost:${private1GatePort}`,
        upstreamUrl: `http://localhost:${private1UpstreamPort}`,
    });

    const private1UpstreamEnv = buildEnv({
        PORT: private1UpstreamPort,
    });

    const private2StaticEnv = buildEnv({
        PORT: private2UpstreamPort,
    });

    const private2GateConfigPath = createEphemeralGateConfigPath({
        directUse,
        port: listenPort(private2GatePort),
        trustProxy: options.behindProxy === true,
        publicOrigin: `http://localhost:${private2GatePort}`,
        upstreamUrl: `http://localhost:${private2UpstreamPort}`,
    });

    const mailSinkEnv = buildEnv({
        MAIL_SINK_HTTP_HOST: '127.0.0.1',
        MAIL_SINK_HTTP_PORT: mailSinkHttpPort,
        MAIL_SINK_SMTP_HOST: '127.0.0.1',
        MAIL_SINK_SMTP_PASS: 'test-password',
        MAIL_SINK_SMTP_PORT: mailSinkSmtpPort,
        MAIL_SINK_SMTP_USER: 'test-user',
        WEB_SERVER_COMMAND: 'pnpm mail-sink',
    });

    const proxyWebServers: TestConfigWebServer[] = [
        {
            command: `node ${quietWebServerScript}`,
            cwd: packageDir,
            env: buildEnv({
                WEB_SERVER_COMMAND: 'node src/reverse-proxy.ts',
                MAGICSSO_E2E_PROXY_ROUTES: JSON.stringify(
                    [
                        nextPort,
                        nuxtPort,
                        angularPort,
                        fastifyPort,
                        djangoPort,
                        private1GatePort,
                        private2GatePort,
                    ].map((port) => ({
                        publicPort: Number(port),
                        upstreamPort: Number(listenPort(port)),
                        replaceHost: port === nextPort || port === nuxtPort,
                    })),
                ),
            }),
            gracefulShutdown: gracefulWebServerShutdown,
            port: Number(nextPort),
            reuseExistingServer: false,
            stdout: 'ignore',
            stderr: 'pipe',
            timeout: 30_000,
        },
    ];

    return defineConfig({
        testDir: resolve(packageDir, 'tests'),
        testMatch: options.testMatch,
        timeout: 60_000,
        expect: {
            timeout: 15_000,
        },
        fullyParallel: false,
        forbidOnly: isCi,
        retries: isCi ? 2 : 0,
        reporter: isCi ? [['github'], ['html', { open: 'never' }]] : 'list',
        use: {
            ...(typeof slowMo === 'number'
                ? {
                      launchOptions: {
                          slowMo,
                      },
                  }
                : {}),
            trace: 'retain-on-failure',
        },
        webServer: [
            ...(options.behindProxy ? proxyWebServers : []),
            {
                command: `node ${quietWebServerScript}`,
                cwd: packageDir,
                env: mailSinkEnv,
                gracefulShutdown: gracefulWebServerShutdown,
                port: Number.parseInt(mailSinkHttpPort, 10),
                reuseExistingServer: false,
                stderr: 'pipe',
                stdout: 'ignore',
                timeout: 30_000,
            },
            {
                command: `node ${quietWebServerScript}`,
                cwd: repoRoot,
                env: {
                    ...serverEnv,
                    WEB_SERVER_COMMAND:
                        'pnpm --filter magic-sso-server build && pnpm --filter magic-sso-server start',
                },
                gracefulShutdown: gracefulWebServerShutdown,
                url: `http://localhost:${serverPort}/healthz`,
                reuseExistingServer: false,
                stderr: 'pipe',
                stdout: 'ignore',
                timeout: 60_000,
            },
            {
                command: `node ${quietWebServerScript}`,
                cwd: repoRoot,
                env: {
                    ...nextEnv,
                    WEB_SERVER_COMMAND: `pnpm --filter example-app-nextjs build && pnpm --filter example-app-nextjs exec next start -p ${listenPort(nextPort)}`,
                },
                gracefulShutdown: gracefulWebServerShutdown,
                url: `http://localhost:${listenPort(nextPort)}/login`,
                reuseExistingServer: false,
                stderr: 'pipe',
                stdout: 'ignore',
                timeout: 120_000,
            },
            {
                command: `node ${quietWebServerScript}`,
                cwd: repoRoot,
                env: {
                    ...nuxtEnv,
                    WEB_SERVER_COMMAND: `pnpm --filter example-app-nuxt build && pnpm --filter example-app-nuxt exec nuxt start --port ${listenPort(nuxtPort)}`,
                },
                gracefulShutdown: gracefulWebServerShutdown,
                url: `http://localhost:${listenPort(nuxtPort)}/login`,
                reuseExistingServer: false,
                stderr: 'pipe',
                stdout: 'ignore',
                timeout: 120_000,
            },
            {
                command: `node ${quietWebServerScript}`,
                cwd: repoRoot,
                env: {
                    ...angularEnv,
                    WEB_SERVER_COMMAND:
                        'pnpm --filter example-app-angular build && pnpm --filter example-app-angular start',
                },
                gracefulShutdown: gracefulWebServerShutdown,
                url: `http://localhost:${listenPort(angularPort)}/login`,
                reuseExistingServer: false,
                stderr: 'pipe',
                stdout: 'ignore',
                timeout: 120_000,
            },
            {
                command: `node ${quietWebServerScript}`,
                cwd: repoRoot,
                env: {
                    ...fastifyEnv,
                    WEB_SERVER_COMMAND:
                        'pnpm --filter example-app-fastify build && pnpm --filter example-app-fastify start',
                },
                gracefulShutdown: gracefulWebServerShutdown,
                url: `http://localhost:${listenPort(fastifyPort)}/login`,
                reuseExistingServer: false,
                stderr: 'pipe',
                stdout: 'ignore',
                timeout: 120_000,
            },
            {
                command: `node ${quietWebServerScript}`,
                cwd: repoRoot,
                env: {
                    ...private1UpstreamEnv,
                    WEB_SERVER_COMMAND:
                        'pnpm --filter example-app-gate-private1 build && pnpm --filter example-app-gate-private1 start',
                },
                gracefulShutdown: gracefulWebServerShutdown,
                url: `http://localhost:${private1UpstreamPort}/healthz`,
                reuseExistingServer: false,
                stderr: 'pipe',
                stdout: 'ignore',
                timeout: 120_000,
            },
            {
                command: `node ${quietWebServerScript}`,
                cwd: repoRoot,
                env: {
                    MAGIC_GATE_CONFIG_FILE: private1GateConfigPath,
                    WEB_SERVER_COMMAND:
                        'pnpm --filter magic-sso-gate build && pnpm --filter magic-sso-gate start',
                },
                gracefulShutdown: gracefulWebServerShutdown,
                url: `http://localhost:${listenPort(private1GatePort)}/_magicgate/healthz`,
                reuseExistingServer: false,
                stderr: 'pipe',
                stdout: 'ignore',
                timeout: 120_000,
            },
            {
                command: `node ${quietWebServerScript}`,
                cwd: repoRoot,
                env: {
                    ...private2StaticEnv,
                    WEB_SERVER_COMMAND:
                        'pnpm --filter example-app-gate-private2-static build && pnpm --filter example-app-gate-private2-static start',
                },
                gracefulShutdown: gracefulWebServerShutdown,
                url: `http://localhost:${private2UpstreamPort}/`,
                reuseExistingServer: false,
                stderr: 'pipe',
                stdout: 'ignore',
                timeout: 120_000,
            },
            {
                command: `node ${quietWebServerScript}`,
                cwd: repoRoot,
                env: {
                    MAGIC_GATE_CONFIG_FILE: private2GateConfigPath,
                    WEB_SERVER_COMMAND:
                        'pnpm --filter magic-sso-gate build && pnpm --filter magic-sso-gate start',
                },
                gracefulShutdown: gracefulWebServerShutdown,
                url: `http://localhost:${listenPort(private2GatePort)}/_magicgate/healthz`,
                reuseExistingServer: false,
                stderr: 'pipe',
                stdout: 'ignore',
                timeout: 120_000,
            },
            {
                command: `node ${quietWebServerScript}`,
                cwd: resolve(repoRoot, 'examples/django'),
                env: {
                    ...djangoEnv,
                    WEB_SERVER_COMMAND: `UV_CACHE_DIR=/tmp/uv-cache uv run python manage.py runserver ${listenPort(djangoPort)} --noreload`,
                },
                gracefulShutdown: gracefulWebServerShutdown,
                url: `http://localhost:${listenPort(djangoPort)}/`,
                reuseExistingServer: false,
                stderr: 'pipe',
                stdout: 'ignore',
                timeout: 60_000,
            },
        ],
    });
}

export function createManagerE2eConfig(): ReturnType<typeof defineConfig> {
    const isCi = process.env.CI === 'true';
    const slowMo = parseOptionalPositiveInteger(process.env.PW_SLOWMO_MS);
    const managerSettingsPaths = createEphemeralManagerSettingsPaths();
    process.env['MAGICSSO_E2E_MANAGER_CONFIG_FILE'] = managerSettingsPaths.configPath;
    const managerGateConfigPath = createEphemeralGateConfigPath({
        directUse: false,
        port: managerGatePort,
        publicOrigin: `http://localhost:${managerGatePort}`,
        upstreamUrl: `http://127.0.0.1:${managerServicePort}`,
    });

    const serverEnv = buildEnv({
        MAGICSSO_CONFIG_FILE: managerSettingsPaths.runtimeConfigFile,
        MAGICSSO_MANAGER_CONFIG_FILE: managerSettingsPaths.bootstrapConfigPath,
    });

    const managerEnv = buildEnv({
        MAGICSSO_MANAGER_CONFIG_FILE: managerSettingsPaths.configPath,
    });

    const photosEnv = buildEnv({
        MAGICSSO_COOKIE_NAME: 'magic-sso',
        MAGICSSO_COOKIE_MAX_AGE: '3600',
        MAGICSSO_DIRECT_USE: 'false',
        MAGICSSO_JWT_SECRET: sharedJwtSecret,
        MAGICSSO_PREVIEW_SECRET: sharedPreviewSecret,
        MAGICSSO_PUBLIC_ORIGIN: `http://localhost:${photosPort}`,
        MAGICSSO_SERVER_URL: `http://localhost:${serverPort}`,
    });

    const mailSinkEnv = buildEnv({
        MAIL_SINK_HTTP_HOST: '127.0.0.1',
        MAIL_SINK_HTTP_PORT: mailSinkHttpPort,
        MAIL_SINK_SMTP_HOST: '127.0.0.1',
        MAIL_SINK_SMTP_PASS: 'test-password',
        MAIL_SINK_SMTP_PORT: mailSinkSmtpPort,
        MAIL_SINK_SMTP_USER: 'test-user',
        WEB_SERVER_COMMAND: 'pnpm mail-sink',
    });

    return defineConfig({
        testDir: resolve(packageDir, 'tests'),
        testMatch: /manager-wave8\.spec\.ts/u,
        timeout: 60_000,
        expect: {
            timeout: 15_000,
        },
        fullyParallel: false,
        forbidOnly: isCi,
        retries: isCi ? 2 : 0,
        reporter: isCi ? [['github'], ['html', { open: 'never' }]] : 'list',
        use: {
            ...(typeof slowMo === 'number'
                ? {
                      launchOptions: {
                          slowMo,
                      },
                  }
                : {}),
            trace: 'retain-on-failure',
        },
        webServer: [
            {
                command: `node ${quietWebServerScript}`,
                cwd: packageDir,
                env: mailSinkEnv,
                gracefulShutdown: gracefulWebServerShutdown,
                port: Number.parseInt(mailSinkHttpPort, 10),
                reuseExistingServer: false,
                stderr: 'pipe',
                stdout: 'ignore',
                timeout: 30_000,
            },
            {
                command: `node ${quietWebServerScript}`,
                cwd: repoRoot,
                env: {
                    ...serverEnv,
                    WEB_SERVER_COMMAND:
                        'pnpm --filter magic-sso-manager build && node manager/dist/cli.js apply --yes && pnpm --filter magic-sso-server build && pnpm --filter magic-sso-server start',
                },
                gracefulShutdown: gracefulWebServerShutdown,
                url: `http://localhost:${serverPort}/healthz`,
                reuseExistingServer: false,
                stderr: 'pipe',
                stdout: 'ignore',
                timeout: 120_000,
            },
            {
                command: `node ${quietWebServerScript}`,
                cwd: repoRoot,
                env: {
                    ...photosEnv,
                    WEB_SERVER_COMMAND:
                        'pnpm --filter example-app-photos build && pnpm --filter example-app-photos start',
                },
                gracefulShutdown: gracefulWebServerShutdown,
                url: `http://localhost:${photosPort}/login`,
                reuseExistingServer: false,
                stderr: 'pipe',
                stdout: 'ignore',
                timeout: 120_000,
            },
            {
                command: `node ${quietWebServerScript}`,
                cwd: repoRoot,
                env: {
                    ...managerEnv,
                    WEB_SERVER_COMMAND:
                        'pnpm --filter magic-sso-manager build && pnpm --filter magic-sso-manager start',
                },
                gracefulShutdown: gracefulWebServerShutdown,
                url: `http://127.0.0.1:${managerServicePort}/healthz`,
                reuseExistingServer: false,
                stderr: 'pipe',
                stdout: 'ignore',
                timeout: 120_000,
            },
            {
                command: `node ${quietWebServerScript}`,
                cwd: repoRoot,
                env: {
                    MAGIC_GATE_CONFIG_FILE: managerGateConfigPath,
                    WEB_SERVER_COMMAND:
                        'pnpm --filter magic-sso-gate build && pnpm --filter magic-sso-gate start',
                },
                gracefulShutdown: gracefulWebServerShutdown,
                url: `http://localhost:${managerGatePort}/_magicgate/healthz`,
                reuseExistingServer: false,
                stderr: 'pipe',
                stdout: 'ignore',
                timeout: 120_000,
            },
        ],
    });
}

/** Test the files produced by setup, using the existing SMTP and process harness. */
export function createStarterE2eConfig(): ReturnType<typeof defineConfig> {
    const path = process.env.MAGICSSO_STARTER_PATH;
    if (path !== 'gate' && path !== 'sdk') {
        throw new Error('MAGICSSO_STARTER_PATH must be gate or sdk.');
    }
    const appPort = path === 'gate' ? private1GatePort : nextPort;
    const temporary = mkdtempSync(join(tmpdir(), 'magic-sso-starter-e2e-'));
    const output = writeStarter({
        path,
        emails: ['owner@example.com', 'friend@example.com'],
        output: join(temporary, 'starter'),
        serverOrigin: `http://localhost:${serverPort}`,
        appOrigin: `http://localhost:${appPort}`,
        upstreamUrl: `http://127.0.0.1:${private1UpstreamPort}`,
        smtpPort: Number(mailSinkSmtpPort),
        smtpUser: 'test-user',
        smtpPassword: 'test-password',
    });
    if (path === 'sdk') {
        // Exercise the generated standalone app with this checkout's SDK and
        // dependencies; the generated manifest itself uses published packages.
        symlinkSync(
            resolve(repoRoot, 'examples/nextjs/node_modules'),
            join(output, 'app/node_modules'),
            'dir',
        );
    }
    const quote = (value: string): string => `'${value.replaceAll("'", "'\\''")}'`;
    const common = {
        command: `node ${quietWebServerScript}`,
        gracefulShutdown: gracefulWebServerShutdown,
        reuseExistingServer: false,
        stderr: 'pipe',
        stdout: 'ignore',
        timeout: 120_000,
    } satisfies Partial<TestConfigWebServer>;
    return defineConfig({
        testDir: resolve(packageDir, 'tests'),
        testMatch: /starter-onboarding\.spec\.ts/u,
        workers: 1,
        timeout: 60_000,
        expect: { timeout: 15_000 },
        forbidOnly: Boolean(process.env.CI),
        use: { trace: 'retain-on-failure' },
        webServer: [
            {
                ...common,
                cwd: packageDir,
                port: Number(mailSinkHttpPort),
                env: buildEnv({
                    MAIL_SINK_HTTP_PORT: mailSinkHttpPort,
                    MAIL_SINK_SMTP_PORT: mailSinkSmtpPort,
                    WEB_SERVER_COMMAND: 'pnpm mail-sink',
                }),
            },
            {
                ...common,
                cwd: repoRoot,
                url: `http://localhost:${serverPort}/healthz`,
                env: buildEnv({
                    MAGICSSO_CONFIG_FILE: join(output, 'magic-sso.toml'),
                    WEB_SERVER_COMMAND:
                        'pnpm --filter magic-sso-server build && pnpm --filter @magic-link-sso/nextjs build && pnpm --filter magic-sso-server start',
                }),
            },
            ...(path === 'gate'
                ? [
                      {
                          ...common,
                          cwd: repoRoot,
                          port: Number(private1UpstreamPort),
                          env: buildEnv({
                              PORT: private1UpstreamPort,
                              WEB_SERVER_COMMAND: 'node starters/gate/upstream.mjs',
                          }),
                      },
                  ]
                : []),
            {
                ...common,
                cwd: path === 'gate' ? repoRoot : join(output, 'app'),
                url: `http://localhost:${appPort}${path === 'gate' ? '/_magicgate/healthz' : '/'}`,
                env: buildEnv({
                    MAGIC_GATE_CONFIG_FILE: join(output, 'magic-gate.toml'),
                    WEB_SERVER_COMMAND:
                        path === 'gate'
                            ? 'pnpm --filter magic-sso-gate build && pnpm --filter magic-sso-gate start'
                            : `node ${quote(resolve(repoRoot, 'examples/nextjs/node_modules/next/dist/bin/next'))} dev --webpack --hostname 127.0.0.1 --port ${appPort}`,
                }),
            },
        ],
    });
}
