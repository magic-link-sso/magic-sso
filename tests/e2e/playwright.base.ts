import { defineConfig } from '@playwright/test';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const packageDir = dirname(fileURLToPath(import.meta.url));
const quietWebServerScript = resolve(packageDir, 'src/run-web-server.mjs');
const repoRoot = resolve(packageDir, '../..');
const angularPort = '43104';
const fastifyPort = '43105';
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
const sharedJwtSecret = 'test-jwt-secret-for-e2e-suite-123456';
const sharedPreviewSecret = 'test-preview-secret-for-e2e-suite-123';

function createEphemeralServerConfigPath(): string {
    const tempDir = mkdtempSync(join(tmpdir(), 'magic-sso-e2e-server-'));
    const verifyTokenStoreDir = resolve(tempDir, 'verification-tokens');
    const signInEmailRateLimitStoreDir = resolve(tempDir, 'signin-email-rate-limit');
    const configContents = readFileSync(serverFixtureConfigPath, 'utf8').replace(
        'logLevel = "error"',
        `logLevel = "error"\nverifyTokenStoreDir = "${verifyTokenStoreDir}"\nsignInEmailRateLimitStoreDir = "${signInEmailRateLimitStoreDir}"\n[rateLimit]\nsignInMax = 50\nsignInEmailMax = 50\nsignInPageMax = 50`,
    );
    const configPath = resolve(tempDir, 'server.config.toml');
    writeFileSync(configPath, configContents, 'utf8');
    return configPath;
}

function createEphemeralGateConfigPath(options: {
    directUse: boolean;
    port: string;
    publicOrigin: string;
    upstreamUrl: string;
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
trustProxy = false
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
        testMatch: RegExp;
    }>,
) {
    const isCi = process.env.CI === 'true';
    const slowMo = parseOptionalPositiveInteger(process.env.PW_SLOWMO_MS);
    const directUse = options.directUse;
    const directUseEnv = directUse ? 'true' : 'false';
    const serverConfigPath = createEphemeralServerConfigPath();

    const serverEnv = buildEnv({
        MAGICSSO_CONFIG_FILE: serverConfigPath,
    });

    const nextEnv = buildEnv({
        MAGICSSO_COOKIE_NAME: 'magic-sso',
        MAGICSSO_COOKIE_MAX_AGE: '3600',
        MAGICSSO_DIRECT_USE: directUseEnv,
        MAGICSSO_JWT_SECRET: sharedJwtSecret,
        MAGICSSO_PREVIEW_SECRET: sharedPreviewSecret,
        MAGICSSO_PUBLIC_ORIGIN: `http://localhost:${nextPort}`,
        MAGICSSO_SERVER_URL: `http://localhost:${serverPort}`,
    });

    const nuxtEnv = buildEnv({
        APP_URL: `http://localhost:${nuxtPort}`,
        MAGICSSO_COOKIE_NAME: 'magic-sso',
        MAGICSSO_COOKIE_MAX_AGE: '3600',
        MAGICSSO_DIRECT_USE: directUseEnv,
        MAGICSSO_JWT_SECRET: sharedJwtSecret,
        MAGICSSO_PREVIEW_SECRET: sharedPreviewSecret,
        MAGICSSO_PUBLIC_ORIGIN: `http://localhost:${nuxtPort}`,
        MAGICSSO_SERVER_URL: `http://localhost:${serverPort}`,
    });

    const djangoEnv = buildEnv({
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
        PORT: angularPort,
    });

    const fastifyEnv = buildEnv({
        MAGICSSO_COOKIE_NAME: 'magic-sso',
        MAGICSSO_COOKIE_MAX_AGE: '3600',
        MAGICSSO_DIRECT_USE: directUseEnv,
        MAGICSSO_JWT_SECRET: sharedJwtSecret,
        MAGICSSO_PREVIEW_SECRET: sharedPreviewSecret,
        MAGICSSO_SERVER_URL: `http://localhost:${serverPort}`,
        PORT: fastifyPort,
    });

    const private1GateConfigPath = createEphemeralGateConfigPath({
        directUse,
        port: private1GatePort,
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
        port: private2GatePort,
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
            {
                command: `node ${quietWebServerScript}`,
                cwd: packageDir,
                env: mailSinkEnv,
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
                    WEB_SERVER_COMMAND: `pnpm --filter example-app-nextjs build && pnpm --filter example-app-nextjs exec next start -p ${nextPort}`,
                },
                url: `http://localhost:${nextPort}/login`,
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
                    WEB_SERVER_COMMAND: `pnpm --filter example-app-nuxt build && pnpm --filter example-app-nuxt exec nuxt start --port ${nuxtPort}`,
                },
                url: `http://localhost:${nuxtPort}/login`,
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
                url: `http://localhost:${angularPort}/login`,
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
                url: `http://localhost:${fastifyPort}/login`,
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
                url: `http://localhost:${private1GatePort}/_magicgate/healthz`,
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
                url: `http://localhost:${private2GatePort}/_magicgate/healthz`,
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
                    WEB_SERVER_COMMAND: `UV_CACHE_DIR=/tmp/uv-cache uv run python manage.py runserver ${djangoPort} --noreload`,
                },
                url: `http://localhost:${djangoPort}/`,
                reuseExistingServer: false,
                stderr: 'pipe',
                stdout: 'ignore',
                timeout: 60_000,
            },
        ],
    });
}
