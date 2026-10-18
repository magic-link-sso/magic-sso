// SPDX-License-Identifier: MIT
import { defineConfig, type PlaywrightTestConfig } from '@playwright/test';
import { execFileSync } from 'node:child_process';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
    browserSsoHttps,
    browserSsoListenPort,
    browserSsoOrigin,
    browserSsoTestHosts,
    type BrowserSsoFixtureRole,
} from './src/browser-sso-fixture.js';
const root = fileURLToPath(new URL('../..', import.meta.url));
const sharedEnv: Record<string, string> = {
    DOTENV_CONFIG_PATH: '/dev/null',
    MAGICSSO_DOTENV_PATH: '/dev/null',
    MAGICSSO_BROWSER_SSO_MODE: 'required',
    MAGICSSO_BROWSER_SSO_LOGIN_UI:
        process.env.MAGICSSO_E2E_SSO_APP_OWNED === 'true' ? 'app-owned' : 'hosted',
    MAGICSSO_BROWSER_SSO_ALLOW_INSECURE_LOCALHOST: String(!browserSsoHttps),
    MAGICSSO_SERVER_URL: browserSsoOrigin('issuer'),
    MAGICSSO_JWT_SECRET: 'test-browser-sso-jwt-secret-0123456789abcdef',
    MAGICSSO_PREVIEW_SECRET: 'test-browser-sso-preview-secret-0123456789',
    MAGICSSO_COOKIE_NAME: 'magic-sso',
    MAGICSSO_COOKIE_PATH: '/',
    MAGICSSO_DIRECT_USE: 'true',
};
if (browserSsoHttps) {
    const directory =
        process.env.MAGICSSO_E2E_TLS_DIR ?? mkdtempSync(join(tmpdir(), 'magic-sso-https-e2e-'));
    if (!process.env.MAGICSSO_E2E_TLS_DIR) {
        execFileSync(
            'openssl',
            [
                'req',
                '-x509',
                '-newkey',
                'rsa:2048',
                '-nodes',
                '-days',
                '1',
                '-keyout',
                join(directory, 'key.pem'),
                '-out',
                join(directory, 'cert.pem'),
                '-subj',
                '/CN=Magic Link SSO test only',
                '-addext',
                `subjectAltName=${browserSsoTestHosts.map((host) => `DNS:${host}`).join(',')},IP:127.0.0.1`,
                '-addext',
                'basicConstraints=critical,CA:TRUE',
            ],
            { stdio: 'ignore' },
        );
        process.env.MAGICSSO_E2E_TLS_DIR = directory;
    }
    Object.assign(sharedEnv, {
        MAGICSSO_E2E_TLS_DIR: directory,
        NODE_EXTRA_CA_CERTS: join(directory, 'cert.pem'),
        REQUESTS_CA_BUNDLE: join(directory, 'cert.pem'),
        NODE_OPTIONS: `--require ${join(root, 'tests/e2e/src/browser-sso-test-network.cjs')}`,
        NO_PROXY: [...browserSsoTestHosts, 'localhost', '127.0.0.1'].join(','),
        MAGICSSO_TRUST_PROXY: 'true',
    });
}
type WebServer = Exclude<NonNullable<PlaywrightTestConfig['webServer']>, readonly unknown[]>;
function appServer(
    role: Exclude<BrowserSsoFixtureRole, 'issuer' | 'gate-a' | 'gate-b'>,
    command: string,
    cwd = root,
): WebServer {
    const port = browserSsoListenPort(role);
    return {
        command,
        cwd,
        url: `http://127.0.0.1:${port}/`,
        reuseExistingServer: false,
        env: {
            ...sharedEnv,
            MAGICSSO_PUBLIC_ORIGIN: browserSsoOrigin(role),
            HOST: '127.0.0.1',
            PORT: String(port),
            DJANGO_SETTINGS_MODULE: 'app.settings',
            DJANGO_ALLOWED_HOSTS: `127.0.0.1,${new URL(browserSsoOrigin(role)).hostname}`,
            DJANGO_DEBUG: 'true',
        },
        gracefulShutdown: { signal: 'SIGTERM', timeout: 5000 },
        timeout: 180_000,
    };
}
export default defineConfig({
    testDir: './tests',
    testMatch:
        process.env.MAGICSSO_E2E_SSO_APP_OWNED === 'true'
            ? ['browser-sso-app-owned.spec.ts']
            : ['browser-sso.spec.ts', ...(browserSsoHttps ? ['browser-sso-release.spec.ts'] : [])],
    workers: 1,
    timeout: 60_000,
    expect: { timeout: 15_000 },
    use: {
        trace: 'retain-on-failure',
        ...(browserSsoHttps
            ? { ignoreHTTPSErrors: true, proxy: { server: 'http://127.0.0.1:45100' } }
            : {}),
    },
    projects: browserSsoHttps
        ? [
              { name: 'chromium', use: { browserName: 'chromium' } },
              {
                  name: 'firefox',
                  use: {
                      browserName: 'firefox',
                      launchOptions: { firefoxUserPrefs: { 'network.cookie.cookieBehavior': 1 } },
                  },
              },
              { name: 'webkit', use: { browserName: 'webkit' } },
          ]
        : [{ name: 'chromium', use: { browserName: 'chromium' } }],
    globalTeardown: browserSsoHttps ? './src/browser-sso-teardown.ts' : undefined,
    forbidOnly: Boolean(process.env.CI),
    webServer: [
        ...(browserSsoHttps
            ? [
                  {
                      command:
                          'pnpm --filter magic-sso-server exec tsx ../tests/e2e/src/browser-sso-https-proxy.ts',
                      cwd: root,
                      env: sharedEnv,
                      url: 'http://127.0.0.1:45100/ready',
                      reuseExistingServer: false,
                      gracefulShutdown: { signal: 'SIGTERM' as const, timeout: 5000 },
                  },
              ]
            : []), // The webServer API accepts the SIGTERM literal.
        {
            command: 'pnpm mail-sink',
            env: { MAIL_SINK_HTTP_PORT: '43126', MAIL_SINK_SMTP_PORT: '43125' },
            url: 'http://localhost:43126/messages',
            reuseExistingServer: false,
            gracefulShutdown: { signal: 'SIGTERM', timeout: 5000 },
            timeout: 60_000,
        },
        {
            command:
                'pnpm --filter magic-sso-server build && pnpm --filter magic-sso-gate build && pnpm --filter magic-sso-server exec tsx ../tests/e2e/src/browser-sso-stack.ts',
            cwd: root,
            env: sharedEnv,
            url: `http://127.0.0.1:${browserSsoListenPort('issuer')}/test/sso-ready`,
            reuseExistingServer: false,
            gracefulShutdown: { signal: 'SIGTERM', timeout: 5000 },
            timeout: 120_000,
        },
        appServer(
            'next',
            `pnpm --filter example-app-nextjs build && pnpm --filter example-app-nextjs exec next start --hostname 127.0.0.1 --port ${browserSsoListenPort('next')}`,
        ),
        appServer(
            'nuxt',
            `pnpm --filter @magic-link-sso/nuxt build && pnpm --filter example-app-nuxt exec nuxt build && pnpm --filter example-app-nuxt exec nuxt start --port ${browserSsoListenPort('nuxt')}`,
        ),
        appServer(
            'django',
            '.venv/bin/python ../../tests/e2e/src/browser-sso-django-server.py',
            join(root, 'examples/django'),
        ),
        appServer(
            'angular',
            'pnpm --filter example-app-angular build && pnpm --filter example-app-angular start',
        ),
        appServer(
            'fastify',
            'pnpm --filter example-app-fastify build && pnpm --filter example-app-fastify exec node dist/main.js',
        ),
    ],
});
