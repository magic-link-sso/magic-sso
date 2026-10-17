// SPDX-License-Identifier: MIT

import { randomBytes } from 'node:crypto';
import { cpSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { createInterface } from 'node:readline/promises';
import { parseArgs } from 'node:util';
import { fileURLToPath, pathToFileURL } from 'node:url';

const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');

/**
 * @typedef {{
 *   path: 'gate' | 'sdk'; emails: string[]; serverOrigin?: string; appOrigin?: string;
 *   output?: string; upstreamUrl?: string; siteId?: string;
 *   smtpHost?: string; smtpPort?: number; smtpUser?: string; smtpPassword?: string;
 *   smtpSecure?: boolean; emailFrom?: string; serverPort?: number; appPort?: number;
 *   trustProxy?: boolean;
 * }} StarterOptions
 */

/** @param {string} value @param {string} [setting] @returns {string} */
function email(value, setting = '--email') {
    const normalized = value.trim().toLowerCase();
    if (
        !/^(?!\.)(?!.*\.\.)([a-z0-9.!#$%&'*+/=?^_`{|}~-]+)(?<!\.)@([a-z0-9](?:[a-z0-9-]*[a-z0-9])?\.)+[a-z]{2,}$/u.test(
            normalized,
        )
    ) {
        throw new Error(`Provide a valid email address with ${setting}.`);
    }
    return normalized;
}

/** @param {string} value @returns {URL} */
function origin(value) {
    const url = new URL(value);
    if (
        !['http:', 'https:'].includes(url.protocol) ||
        url.username ||
        url.password ||
        url.pathname !== '/' ||
        url.search ||
        url.hash
    ) {
        throw new Error(
            'Origins must be HTTP(S) origins without credentials, paths, queries, or fragments.',
        );
    }
    if (url.protocol === 'http:' && !['localhost', '127.0.0.1', '[::1]'].includes(url.hostname)) {
        throw new Error('Use HTTPS for public origins; HTTP is only supported on loopback hosts.');
    }
    return url;
}

/** @param {number} value @returns {number} */
function port(value) {
    if (!Number.isInteger(value) || value < 1 || value > 65535) {
        throw new Error('Ports must be integers between 1 and 65535.');
    }
    return value;
}

/** @param {string} value @returns {string} */
function shellQuote(value) {
    return `'${value.replaceAll("'", "'\\''")}'`;
}

/**
 * Generate one matching server/client configuration without modifying existing deployments.
 * @param {StarterOptions} options
 * @returns {Record<string, string>}
 */
export function createStarterFiles(options) {
    if (!['gate', 'sdk'].includes(options.path)) {
        throw new Error('Choose gate or sdk. The minimal SDK starter uses Next.js.');
    }
    const emails = [...new Set(options.emails.map((value) => email(value)))];
    if (emails.length === 0) {
        throw new Error('Provide at least one --email address.');
    }
    const siteId = options.siteId ?? 'starter';
    if (!/^[a-z][a-z0-9-]*$/u.test(siteId)) {
        throw new Error(
            'Site IDs must start with a lowercase letter and contain only lowercase letters, digits, or hyphens.',
        );
    }
    const server = origin(options.serverOrigin ?? 'http://localhost:3000');
    const app = origin(
        options.appOrigin ??
            (options.path === 'gate' ? 'http://localhost:4000' : 'http://localhost:3001'),
    );
    if (server.origin === app.origin) {
        throw new Error('The server and application need different origins.');
    }
    const serverPort = port(
        options.serverPort ?? (server.protocol === 'https:' ? 3000 : Number(server.port || 80)),
    );
    const appPort = port(
        options.appPort ??
            (app.protocol === 'https:'
                ? options.path === 'gate'
                    ? 4000
                    : 3001
                : Number(app.port || 80)),
    );
    const smtpPort = port(
        options.smtpPort ?? (options.smtpSecure ? 465 : options.smtpHost ? 587 : 1025),
    );
    const publicDeployment = server.protocol === 'https:' || app.protocol === 'https:';
    if (
        publicDeployment &&
        (!options.smtpHost || !options.smtpUser || !options.smtpPassword || !options.emailFrom)
    ) {
        throw new Error(
            'HTTPS deployments require --smtp-host, --smtp-user, --email-from and MAGICSSO_SETUP_SMTP_PASSWORD.',
        );
    }
    const upstream = new URL(options.upstreamUrl ?? 'http://127.0.0.1:3007');
    if (
        !['http:', 'https:'].includes(upstream.protocol) ||
        upstream.username ||
        upstream.password ||
        upstream.search ||
        upstream.hash
    ) {
        throw new Error(
            'The upstream must be an HTTP(S) URL without credentials, queries, or fragments.',
        );
    }
    const secrets = Object.fromEntries(
        ['jwt', 'csrf', 'email', 'preview'].map((key) => [
            key,
            randomBytes(32).toString('base64url'),
        ]),
    );
    const cookieName = `magic-sso-${siteId}`;
    const callback = options.path === 'gate' ? '/_magicgate/verify-email' : '/verify-email';
    const quote = JSON.stringify;
    /** @type {Record<string, string>} */
    const files = {
        '.gitignore':
            'magic-sso.toml\nmagic-gate.toml\nstate/\napp/.env*\napp/node_modules/\napp/.next/\n',
        'magic-sso.toml': `# Generated by Magic Link SSO setup. Keep this file private.\n[server]
appPort = ${serverPort}
appUrl = ${quote(server.origin)}
trustProxy = ${options.trustProxy ?? false}
verifyTokenStoreDir = ${quote(resolve(options.output ?? `.magic-sso/starter-${options.path}`, 'state/verification-tokens'))}
signInEmailRateLimitStoreDir = ${quote(resolve(options.output ?? `.magic-sso/starter-${options.path}`, 'state/signin-email-rate-limit'))}

[auth]
jwtSecret = ${quote(secrets.jwt)}
csrfSecret = ${quote(secrets.csrf)}
emailSecret = ${quote(secrets.email)}
previewSecret = ${quote(secrets.preview)}
jwtExpiration = "1h"
emailExpiration = "15m"

[cookie]
name = ${quote(cookieName)}
httpOnly = true
sameSite = "lax"
secure = ${server.protocol === 'https:'}

[email]
from = ${quote(email(options.emailFrom ?? 'signin@example.com', '--email-from'))}
signature = "Magic Link SSO"

[email.smtp]
host = ${quote(options.smtpHost ?? '127.0.0.1')}
port = ${smtpPort}
user = ${quote(options.smtpUser ?? 'mailpit')}
pass = ${quote(options.smtpPassword ?? 'mailpit')}
secure = ${options.smtpSecure ?? false}

[[sites]]
id = ${quote(siteId)}
origins = ${quote([app.origin])}
allowedRedirectUris = ${quote([`${app.origin}${callback}`, `${app.origin}/*`])}
allowedEmails = ${quote(emails)}
`,
    };
    if (options.path === 'gate') {
        files['magic-gate.toml'] = `[gate]
port = ${appPort}
mode = "subdomain"
publicOrigin = ${quote(app.origin)}
upstreamUrl = ${quote(upstream.toString())}
namespace = "/_magicgate"
directUse = true
trustProxy = ${options.trustProxy ?? false}
wsEnabled = true

[auth]
serverUrl = ${quote(server.origin)}
jwtSecret = ${quote(secrets.jwt)}
previewSecret = ${quote(secrets.preview)}

[cookie]
name = ${quote(cookieName)}
path = "/"
maxAge = 3600
`;
    } else {
        files['app/.gitignore'] = '.env*\n!.env.example\nnode_modules/\n.next/\n*.tsbuildinfo\n';
        files['app/.env.local'] = `MAGICSSO_SERVER_URL=${server.origin}
MAGICSSO_PUBLIC_ORIGIN=${app.origin}
MAGICSSO_JWT_SECRET=${secrets.jwt}
MAGICSSO_PREVIEW_SECRET=${secrets.preview}
MAGICSSO_COOKIE_NAME=${cookieName}
MAGICSSO_COOKIE_PATH=/
MAGICSSO_COOKIE_MAX_AGE=3600
MAGICSSO_DIRECT_USE=true
MAGICSSO_TRUST_PROXY=${options.trustProxy ?? false}
`;
        const example = JSON.parse(
            readFileSync(join(repositoryRoot, 'examples/nextjs/package.json'), 'utf8'),
        );
        const sdk = JSON.parse(
            readFileSync(join(repositoryRoot, 'packages/nextjs/package.json'), 'utf8'),
        );
        files['app/package.json'] = `${JSON.stringify(
            {
                name: 'magic-link-sso-starter',
                private: true,
                type: 'module',
                scripts: {
                    dev: `next dev --webpack --hostname 127.0.0.1 --port ${appPort}`,
                    build: 'next build --webpack',
                    start: `next start --hostname 127.0.0.1 --port ${appPort}`,
                    typecheck: 'tsc --noEmit',
                },
                dependencies: {
                    '@magic-link-sso/nextjs': `^${sdk.version}`,
                    next: example.dependencies.next,
                    react: example.dependencies.react,
                    'react-dom': example.dependencies['react-dom'],
                },
                devDependencies: {
                    typescript: example.devDependencies.typescript,
                    '@types/node': example.devDependencies['@types/node'],
                    '@types/react': example.devDependencies['@types/react'],
                    '@types/react-dom': example.devDependencies['@types/react-dom'],
                },
                engines: { node: '>=24.15.0' },
            },
            null,
            2,
        )}\n`;
    }
    return files;
}

/** @param {StarterOptions} options @returns {string} */
export function writeStarter(options) {
    const output = resolve(options.output ?? `.magic-sso/starter-${options.path}`);
    const files = createStarterFiles({ ...options, output });
    // mkdir without recursive creation of the target refuses existing directories and symlinks.
    mkdirSync(dirname(output), { recursive: true });
    try {
        mkdirSync(output, { mode: 0o700 });
    } catch (error) {
        if (error instanceof Error && 'code' in error && error.code === 'EEXIST') {
            throw new Error(
                `Output already exists: ${output}. Keep its secrets and config; choose a new directory with --output for another starter.`,
            );
        }
        throw error;
    }
    try {
        if (options.path === 'sdk') {
            cpSync(join(repositoryRoot, 'starters/nextjs'), join(output, 'app'), {
                recursive: true,
            });
        }
        for (const [name, content] of Object.entries(files)) {
            const file = join(output, name);
            mkdirSync(dirname(file), { recursive: true, mode: 0o700 });
            writeFileSync(file, content, { mode: 0o600, flag: 'wx' });
        }
        const config = shellQuote(join(output, 'magic-sso.toml'));
        const client =
            options.path === 'gate'
                ? `MAGIC_GATE_CONFIG_FILE=${shellQuote(join(output, 'magic-gate.toml'))} pnpm --filter magic-sso-gate dev`
                : `npm --prefix ${shellQuote(join(output, 'app'))} install\nnpm --prefix ${shellQuote(join(output, 'app'))} run dev`;
        writeFileSync(
            join(output, 'NEXT-STEPS.md'),
            `# Your Magic Link SSO starter\n\nRun these commands from ${shellQuote(repositoryRoot)}.\n\n1. Follow the ${options.path === 'gate' ? 'Gate' : 'SDK'} path in [First deployment](${pathToFileURL(join(repositoryRoot, 'docs/first-deployment.md')).href}). Start local SMTP there, or use your configured SMTP provider.\n2. Check the server configuration:\n\n\`\`\`sh\npnpm doctor server --config ${config}\npnpm doctor server --config ${config} --online\n\`\`\`\n\n3. Start the server in one terminal:\n\n\`\`\`sh\nMAGICSSO_CONFIG_FILE=${config} pnpm --filter magic-sso-server dev\n\`\`\`\n\n4. ${options.path === 'gate' ? 'Start your private upstream (the default is http://127.0.0.1:3007), then start Gate' : 'Install the generated app dependencies, then start the app'} in another terminal:\n\n\`\`\`sh\n${client}\n\`\`\`\n\n5. Open ${options.appOrigin ?? (options.path === 'gate' ? 'http://localhost:4000' : 'http://localhost:3001')}${options.path === 'sdk' ? '/private' : '/'}, enter ${options.emails[0]}, open the email and confirm sign-in. In local evaluation the email is in Mailpit, not your real inbox.\n\nSee the first-deployment guide for adding people, restarting after access changes, deployment updates, HTTPS, and optional managed mode. Keep these generated secrets when updating; setup deliberately refuses to overwrite this directory.\n`,
            { mode: 0o600 },
        );
        return output;
    } catch (error) {
        rmSync(output, { recursive: true, force: true });
        throw error;
    }
}

const usage = `Usage: pnpm setup:app gate|sdk --email <address> [--email <another>] [--output <new-directory>]
Without arguments, setup asks for a path and the first email. SDK uses a minimal Next.js app.
Options: --server-origin <origin> --app-origin <origin> --site-id <id>
         --upstream-url <url> (Gate) --server-port <port> --app-port <port>
         --smtp-host <host> --smtp-port <port> --smtp-user <user> --smtp-secure
         --email-from <address> --trust-proxy
Provide an SMTP password through MAGICSSO_SETUP_SMTP_PASSWORD. Secrets are generated once;
existing output directories are never overwritten. Local defaults use Mailpit on port 1025.
`;

/** @param {string[]} argv @returns {Promise<number>} */
export async function runSetup(argv) {
    let prompt;
    try {
        const { values, positionals } = parseArgs({
            args: argv,
            allowPositionals: true,
            options: {
                help: { type: 'boolean' },
                email: { type: 'string', multiple: true },
                output: { type: 'string' },
                'server-origin': { type: 'string' },
                'app-origin': { type: 'string' },
                'site-id': { type: 'string' },
                'upstream-url': { type: 'string' },
                'server-port': { type: 'string' },
                'app-port': { type: 'string' },
                'smtp-host': { type: 'string' },
                'smtp-port': { type: 'string' },
                'smtp-user': { type: 'string' },
                'smtp-secure': { type: 'boolean' },
                'email-from': { type: 'string' },
                'trust-proxy': { type: 'boolean' },
            },
        });
        if (values.help) {
            process.stdout.write(usage);
            return 0;
        }
        if (positionals.length > 1) {
            throw new Error('Choose exactly one path: gate or sdk.');
        }
        let path = positionals[0];
        let emails = values.email ?? [];
        if ((!path || emails.length === 0) && process.stdin.isTTY) {
            prompt = createInterface({ input: process.stdin, output: process.stdout });
            path ||= (
                await prompt.question(
                    'Protect an existing app (gate), or build with the Next.js SDK (sdk)? ',
                )
            ).trim();
            if (emails.length === 0) {
                emails = [await prompt.question('Which email should have access? ')];
            }
        }
        if (path !== 'gate' && path !== 'sdk') {
            throw new Error('Choose gate or sdk. Run pnpm setup:app --help for examples.');
        }
        const output = writeStarter({
            path,
            emails,
            output: values.output,
            serverOrigin: values['server-origin'],
            appOrigin: values['app-origin'],
            siteId: values['site-id'],
            upstreamUrl: values['upstream-url'],
            serverPort:
                values['server-port'] === undefined ? undefined : Number(values['server-port']),
            appPort: values['app-port'] === undefined ? undefined : Number(values['app-port']),
            smtpHost: values['smtp-host'],
            smtpPort: values['smtp-port'] === undefined ? undefined : Number(values['smtp-port']),
            smtpUser: values['smtp-user'],
            smtpPassword: process.env.MAGICSSO_SETUP_SMTP_PASSWORD,
            smtpSecure: values['smtp-secure'],
            emailFrom: values['email-from'],
            trustProxy: values['trust-proxy'],
        });
        process.stdout.write(
            `Magic Link SSO ${path === 'gate' ? 'Gate' : 'Next.js SDK'} starter created at ${output}\nNext: open ${join(output, 'NEXT-STEPS.md')}\n`,
        );
        return 0;
    } catch (error) {
        process.stderr.write(
            `Setup failed: ${error instanceof Error ? error.message : String(error)}\n`,
        );
        return 2;
    } finally {
        prompt?.close();
    }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
    process.exitCode = await runSetup(process.argv.slice(2));
}
