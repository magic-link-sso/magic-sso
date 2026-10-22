// SPDX-License-Identifier: MIT
import { randomBytes } from 'node:crypto';
import { join } from 'node:path';

export const DEV_SSO_ISSUER = 'http://127.0.0.1:3000';
export const DEV_SSO_INBOX = 'http://127.0.0.1:8025/';

export const DEV_SSO_APPS = [
    { id: 'angular', name: 'Angular', port: 3004, path: '/protected' },
    { id: 'nextjs', name: 'Next.js', port: 3001, path: '/protected' },
    { id: 'nuxt', name: 'Nuxt', port: 3002, path: '/protected' },
    { id: 'django', name: 'Django', port: 8000, path: '/protected1', slash: '/' },
    { id: 'fastify', name: 'Fastify', port: 3005, path: '/protected' },
    { id: 'photos', name: 'Photos', port: 5001, path: '/' },
    { id: 'private1', name: 'Gate: private1', port: 4000, path: '/' },
    { id: 'private2', name: 'Gate: private2', port: 4001, path: '/' },
];

/** @param {typeof DEV_SSO_APPS[number]} app @returns {string} */
export function devSsoOrigin(app) {
    return `http://${app.id}.localhost:${app.port}`;
}

/** @param {typeof DEV_SSO_APPS[number]} app @returns {string} */
function ssoBase(app) {
    if (app.id.startsWith('private')) {
        return '/_magicgate/sso/';
    }
    return '/sso/';
}

/** @typedef {Pick<import('../packages/config-core/src/index.js').MagicSsoTomlConfig, 'email' | 'sites'>} DevSsoSource */

/** @param {typeof DEV_SSO_APPS[number]} app @param {DevSsoSource | undefined} source @returns {DevSsoSource['sites'][number] | undefined} */
function sourceSite(app, source) {
    const sites = source?.sites ?? [];
    return (
        sites.find((site) => site.id === app.id || site.id === `${app.id}-local`) ??
        sites.find((site) =>
            site.origins.some((value) => {
                const origin = new URL(value);
                return (
                    origin.port === String(app.port) &&
                    ['localhost', '127.0.0.1', `${app.id}.localhost`].includes(origin.hostname)
                );
            }),
        )
    );
}

/** @param {DevSsoSource | undefined} source @param {boolean | undefined} inbox @returns {NonNullable<DevSsoSource['email']>} */
function emailConfig(source, inbox) {
    if (inbox) {
        return {
            ...source?.email,
            from: source?.email?.from ?? 'signin@example.com',
            smtp: {
                host: '127.0.0.1',
                port: 1025,
                user: 'test-user',
                pass: 'test-password',
                secure: false,
            },
        };
    }
    if (!source?.email) {
        throw new Error(
            'Shared SSO development needs the existing server email configuration, or --inbox for local mail.',
        );
    }
    return source.email;
}

/**
 * Keep the normal email delivery and per-site grants; isolate SSO state and keys.
 * @param {string} directory
 * @param {'hosted' | 'app-owned'} loginUi
 * @param {{source?: DevSsoSource; email?: string; inbox?: boolean}} [options]
 * @returns {{issuer: Record<string, unknown>; gates: {id: string; config: Record<string, unknown>}[]; env: Record<string, string>}}
 */
export function createDevSsoConfig(directory, loginUi, options = {}) {
    const secret = () => randomBytes(32).toString('base64url');
    const jwtSecret = secret();
    const previewSecret = secret();
    const issuerOrigin = DEV_SSO_ISSUER;
    const email = emailConfig(options.source, options.inbox);
    const sites = DEV_SSO_APPS.flatMap((app) => {
        const origin = devSsoOrigin(app);
        const base = ssoBase(app);
        const slash = app.slash ?? '';
        const configured = sourceSite(app, options.source);
        if (!configured && !options.email) {
            return [];
        }
        return [
            {
                ...configured,
                id: configured?.id ?? app.id,
                origins: [origin],
                allowedRedirectUris: [`${origin}/*`],
                allowedEmails: [
                    ...new Set([
                        ...(configured?.allowedEmails ?? []),
                        ...(options.email ? [options.email.trim().toLowerCase()] : []),
                    ]),
                ],
                accessRules: configured?.accessRules ?? [],
                launcher: { name: app.name, ...configured?.launcher, launchUrl: origin + app.path },
                sso: [
                    {
                        redirectUri: `${origin}${base}callback${slash}`,
                        startUri: `${origin}${base}start${slash}`,
                        signedOutUri: app.id.startsWith('private')
                            ? `${origin}${base.replace(/sso\/$/u, '')}signed-out`
                            : `${origin}${base}signed-out${slash}`,
                    },
                ],
            },
        ];
    });
    if (sites.length === 0) {
        throw new Error(
            'No matching application grants found. Add --email you@example.com for development access.',
        );
    }
    const gates = DEV_SSO_APPS.filter((app) => app.id.startsWith('private')).map((app, index) => ({
        id: app.id,
        config: {
            gate: {
                port: app.port,
                mode: 'subdomain',
                publicOrigin: devSsoOrigin(app),
                upstreamUrl: `http://127.0.0.1:${3007 + index}`,
                directUse: loginUi === 'hosted',
            },
            auth: {
                jwtSecret,
                previewSecret,
                serverUrl: issuerOrigin,
                sso: { mode: 'required', loginUi, allowInsecureLocalhost: true },
            },
            cookie: { name: 'magic-sso', path: '/' },
        },
    }));
    return {
        issuer: {
            server: {
                appUrl: issuerOrigin,
                appPort: 3000,
                serveRootLandingPage: true,
                logLevel: 'warn',
                verifyTokenStoreDir: join(directory, 'tokens'),
                signInEmailRateLimitStoreDir: join(directory, 'limits'),
            },
            auth: {
                jwtSecret,
                previewSecret,
                emailSecret: secret(),
                csrfSecret: secret(),
                sso: {
                    enabled: true,
                    bootstrapEnabled: loginUi === 'app-owned',
                    allowInsecureLocalhost: true,
                },
                otp: { enabled: true, secret: secret() },
            },
            cookie: { name: 'magic-sso', secure: false, httpOnly: true, sameSite: 'lax' },
            email,
            rateLimit: { signInPageMax: 500, signInMax: 500, verifyMax: 500, signInEmailMax: 100 },
            sites,
        },
        gates,
        env: {
            DOTENV_CONFIG_PATH: '/dev/null',
            MAGICSSO_DOTENV_PATH: '/dev/null',
            MAGICSSO_BROWSER_SSO_MODE: 'required',
            MAGICSSO_BROWSER_SSO_LOGIN_UI: loginUi,
            MAGICSSO_BROWSER_SSO_ALLOW_INSECURE_LOCALHOST: 'true',
            MAGICSSO_BROWSER_SSO_TIMEOUT_MS: '5000',
            MAGICSSO_SERVER_URL: issuerOrigin,
            MAGICSSO_JWT_SECRET: jwtSecret,
            MAGICSSO_PREVIEW_SECRET: previewSecret,
            MAGICSSO_COOKIE_NAME: 'magic-sso',
            MAGICSSO_COOKIE_DOMAIN: '',
            MAGICSSO_COOKIE_PATH: '/',
            MAGICSSO_COOKIE_SECURE: 'false',
            MAGICSSO_COOKIE_SAMESITE: 'Lax',
            MAGICSSO_DIRECT_USE: String(loginUi === 'hosted'),
            MAGICSSO_TRUST_PROXY: 'false',
            MAGICSSO_AUTH_EVERYWHERE: 'false',
            DJANGO_DEBUG: 'true',
            DJANGO_ALLOWED_HOSTS: '127.0.0.1,django.localhost',
            ...(options.email ? { PHOTOS_OWNER_EMAIL: options.email.trim().toLowerCase() } : {}),
        },
    };
}

/** @param {string} directory @param {boolean} [inbox] @returns {{id: string; cwd: string; command: string; args: string[]; env: Record<string, string>}[]} */
export function createDevSsoJobs(directory, inbox = false) {
    const jobs = [
        ...(inbox
            ? [
                  {
                      id: 'mail',
                      cwd: 'tests/e2e',
                      command: 'pnpm',
                      args: ['mail-sink'],
                      env: {
                          MAIL_SINK_HTTP_HOST: '127.0.0.1',
                          MAIL_SINK_SMTP_HOST: '127.0.0.1',
                          MAIL_SINK_HTTP_PORT: '8025',
                          MAIL_SINK_SMTP_PORT: '1025',
                          MAIL_SINK_SMTP_USER: 'test-user',
                          MAIL_SINK_SMTP_PASS: 'test-password',
                      },
                  },
              ]
            : []),
        {
            id: 'issuer',
            cwd: 'server',
            command: 'pnpm',
            args: ['dev'],
            env: { MAGICSSO_CONFIG_FILE: join(directory, 'issuer.toml') },
        },
    ];
    for (const app of DEV_SSO_APPS) {
        const env = { MAGICSSO_PUBLIC_ORIGIN: devSsoOrigin(app), PORT: String(app.port) };
        const exec = ['exec'];
        if (app.id.startsWith('private')) {
            jobs.push({
                id: app.id,
                cwd: 'gate',
                command: 'pnpm',
                args: ['dev'],
                env: { MAGIC_GATE_CONFIG_FILE: join(directory, `${app.id}.toml`) },
            });
        } else if (app.id === 'angular') {
            jobs.push({
                id: app.id,
                cwd: 'examples/angular',
                command: 'pnpm',
                args: [...exec, 'ng', 'serve', '--host', '127.0.0.1', '--port', String(app.port)],
                env,
            });
        } else if (app.id === 'django') {
            jobs.push({
                id: app.id,
                cwd: 'examples/django',
                command: '.venv/bin/python',
                args: ['manage.py', 'runserver', `127.0.0.1:${app.port}`],
                env,
            });
        } else if (app.id === 'nextjs' || app.id === 'photos') {
            jobs.push({
                id: app.id,
                cwd: `examples/${app.id}`,
                command: 'pnpm',
                args: [
                    ...exec,
                    'next',
                    'dev',
                    '--webpack',
                    '--hostname',
                    '127.0.0.1',
                    '--port',
                    String(app.port),
                ],
                env,
            });
        } else if (app.id === 'nuxt') {
            jobs.push({
                id: app.id,
                cwd: 'examples/nuxt',
                command: 'pnpm',
                args: [...exec, 'nuxt', 'dev', '--host', '127.0.0.1', '--port', String(app.port)],
                env,
            });
        } else {
            jobs.push({ id: app.id, cwd: 'examples/fastify', command: 'pnpm', args: ['dev'], env });
        }
    }
    jobs.push(
        {
            id: 'upstream1',
            cwd: 'examples/gate-private1-app',
            command: 'pnpm',
            args: ['dev'],
            env: { PORT: '3007' },
        },
        {
            id: 'upstream2',
            cwd: 'examples/gate-private2-static',
            command: 'pnpm',
            args: ['dev'],
            env: { PORT: '3008' },
        },
    );
    return jobs;
}
