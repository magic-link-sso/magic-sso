// SPDX-License-Identifier: MIT
// Ephemeral browser SSO fixture. All credentials below are public test values.
import { createServer } from 'node:http';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { buildApp } from 'magic-sso-server/dist/app.js';
import { parseMagicSsoConfigToml } from 'magic-sso-server/dist/config.js';
import { createApp } from 'magic-sso-gate/dist/app.js';
import type { GateConfigInput } from 'magic-sso-gate/dist/config.js';

import { browserSsoOrigin, browserSsoListenPort, browserSsoHttps } from './browser-sso-fixture.js';
const issuer = browserSsoOrigin('issuer');
const first = browserSsoOrigin('gate-a');
const second = browserSsoOrigin('gate-b');
const jwtSecret = 'test-browser-sso-jwt-secret-0123456789abcdef';
const previewSecret = 'test-browser-sso-preview-secret-0123456789';
const directory = await mkdtemp(join(tmpdir(), 'magic-sso-browser-e2e-'));
const config = parseMagicSsoConfigToml(
    `
[server]
appPort = ${browserSsoListenPort('issuer')}
appUrl = "${issuer}"
logLevel = "error"
verifyTokenStoreDir = "${join(directory, 'tokens')}"
signInEmailRateLimitStoreDir = "${join(directory, 'limits')}"
[auth]
jwtSecret = "${jwtSecret}"
previewSecret = "${previewSecret}"
emailSecret = "test-browser-sso-email-secret-0123456789abc"
csrfSecret = "test-browser-sso-csrf-secret-0123456789abcd"
[auth.sso]
enabled = true
bootstrapEnabled = ${process.env.MAGICSSO_E2E_SSO_APP_OWNED === 'true'}
allowInsecureLocalhost = ${!browserSsoHttps}
[auth.otp]
enabled = true
secret = "test-browser-sso-otp-secret-0123456789abcde"
[email]
from = "signin@example.com"
[email.smtp]
host = "127.0.0.1"
port = 43125
user = "test-user"
pass = "test-password"
secure = false
[rateLimit]
signInPageMax = 500
signInMax = 500
verifyMax = 500
signInEmailMax = 100
[[sites]]
id = "gate-a"
origins = ["${first}"]
allowedRedirectUris = ["${first}/*"]
allowedEmails = ["owner@example.com"]
[[sites.sso]]
redirectUri = "${first}/_magicgate/sso/callback"
startUri = "${first}/_magicgate/sso/start"
signedOutUri = "${first}/_magicgate/signed-out"
[[sites]]
id = "gate-b"
origins = ["${second}"]
allowedRedirectUris = ["${second}/private/*"]
allowedEmails = ["owner@example.com"]
[[sites.sso]]
redirectUri = "${second}/private/_access/sso/callback"
startUri = "${second}/private/_access/sso/start"
signedOutUri = "${second}/private/_access/signed-out"
[[sites]]
id = "next"
origins = ["${browserSsoOrigin('next')}"]
allowedRedirectUris = ["${browserSsoOrigin('next')}/*"]
allowedEmails = ["owner@example.com"]
[[sites.sso]]
redirectUri = "${browserSsoOrigin('next')}/sso/callback"
startUri = "${browserSsoOrigin('next')}/sso/start"
signedOutUri = "${browserSsoOrigin('next')}/sso/signed-out"
[[sites]]
id = "nuxt"
origins = ["${browserSsoOrigin('nuxt')}"]
allowedRedirectUris = ["${browserSsoOrigin('nuxt')}/*"]
allowedEmails = ["owner@example.com"]
[[sites.sso]]
redirectUri = "${browserSsoOrigin('nuxt')}/sso/callback"
startUri = "${browserSsoOrigin('nuxt')}/sso/start"
signedOutUri = "${browserSsoOrigin('nuxt')}/sso/signed-out"
[[sites]]
id = "django"
origins = ["${browserSsoOrigin('django')}"]
allowedRedirectUris = ["${browserSsoOrigin('django')}/*"]
allowedEmails = ["owner@example.com"]
[[sites.sso]]
redirectUri = "${browserSsoOrigin('django')}/sso/callback/"
startUri = "${browserSsoOrigin('django')}/sso/start/"
signedOutUri = "${browserSsoOrigin('django')}/sso/signed-out/"
[[sites]]
id = "angular"
origins = ["${browserSsoOrigin('angular')}"]
allowedRedirectUris = ["${browserSsoOrigin('angular')}/*"]
allowedEmails = ["owner@example.com"]
[[sites.sso]]
redirectUri = "${browserSsoOrigin('angular')}/sso/callback"
startUri = "${browserSsoOrigin('angular')}/sso/start"
signedOutUri = "${browserSsoOrigin('angular')}/sso/signed-out"
[[sites]]
id = "fastify"
origins = ["${browserSsoOrigin('fastify')}"]
allowedRedirectUris = ["${browserSsoOrigin('fastify')}/*"]
allowedEmails = ["owner@example.com"]
[[sites.sso]]
redirectUri = "${browserSsoOrigin('fastify')}/sso/callback"
startUri = "${browserSsoOrigin('fastify')}/sso/start"
signedOutUri = "${browserSsoOrigin('fastify')}/sso/signed-out"
[[sites]]
id = "compat"
origins = ["${browserSsoOrigin('compat')}"]
allowedRedirectUris = ["${browserSsoOrigin('compat')}/*"]
allowedEmails = ["owner@example.com"]
[[sites.sso]]
redirectUri = "${browserSsoOrigin('compat')}/_magicgate/sso/callback"
startUri = "${browserSsoOrigin('compat')}/_magicgate/sso/start"
signedOutUri = "${browserSsoOrigin('compat')}/_magicgate/signed-out"
`,
    'ephemeral-browser-sso-fixture',
);

const upstream = createServer((request, response) => {
    const site = request.headers['x-magic-sso-site-id'];
    const namespace = site === 'gate-b' ? '/private/_access' : '/_magicgate';
    response.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
    response.end(`<!doctype html><html lang="en"><title>Protected Gate</title><main>
      <h1>Protected application</h1><p data-testid="site">${site === 'gate-a' ? 'gate-a' : site === 'compat' ? 'compat' : 'gate-b'}</p>
      <p data-testid="email">${request.headers['x-magic-sso-user-email'] === 'owner@example.com' ? 'owner@example.com' : request.headers['x-magic-sso-user-email'] === 'other@example.com' ? 'other@example.com' : 'unknown'}</p>
      <form method="post" action="${namespace}/logout"><button>Sign out of this application</button></form>
      </main></html>`);
});
await new Promise<void>((resolve, reject) => {
    upstream.once('error', reject);
    upstream.listen(45003, '127.0.0.1', resolve);
});
const server = await buildApp({ config, logger: false });

// Test-only fault/grant controls exist exclusively in this ephemeral fixture.
let dropNextExchange = false;
let exchanges = 0;
let capabilityMode: 'normal' | '404' | 'disabled' = 'normal';
let compatGate: Awaited<ReturnType<typeof createApp>> | undefined;
let pauseNextAuthorization = false;
let pausedCallback = '';
let pauseNextBootstrap = false;
let pausedBootstrapUrl = '';
let dropNextBootstrap = false;
server.addHook('onRequest', async (request, reply): Promise<void> => {
    if (
        pauseNextBootstrap &&
        request.method === 'GET' &&
        request.url.startsWith('/sso/bootstrap/redeem?')
    ) {
        pauseNextBootstrap = false;
        pausedBootstrapUrl = request.url;
        reply
            .type('text/html')
            .send(
                '<h1>Paused before shared session</h1><a href="/test/resume-bootstrap">Complete shared sign-in</a>',
            );
        return;
    }
    if (request.url === '/sso/exchange') {
        exchanges += 1;
    }
});
server.addHook('onSend', async (request, reply, payload) => {
    if (request.url === '/sso/capabilities' && capabilityMode !== 'normal') {
        reply.removeHeader('content-length');
        reply.code(capabilityMode === '404' ? 404 : 200);
        return JSON.stringify(
            capabilityMode === '404'
                ? { message: 'Not found' }
                : { browserSso: { version: 1, enabled: false } },
        );
    }
    if (
        dropNextBootstrap &&
        request.url.startsWith('/sso/bootstrap/redeem?') &&
        reply.statusCode === 302
    ) {
        dropNextBootstrap = false;
        reply.removeHeader('location');
        reply.removeHeader('set-cookie');
        reply.removeHeader('content-length');
        reply.code(502).type('text/html');
        return '<h1>Shared sign-in result unavailable</h1>';
    }
    const location = reply.getHeader('location');
    if (
        pauseNextAuthorization &&
        request.url.startsWith('/sso/authorize?') &&
        typeof location === 'string' &&
        location.includes('/sso/callback?')
    ) {
        pauseNextAuthorization = false;
        pausedCallback = location;
        reply.removeHeader('location');
        reply.removeHeader('content-length');
        reply.code(200).type('text/html');
        return '<h1>Paused before callback</h1>';
    }
    if (request.url === '/sso/exchange') {
        if (dropNextExchange && reply.statusCode === 200) {
            dropNextExchange = false;
            // Consume the real code, then lose its successful result at the transport boundary.
            reply.removeHeader('content-length');
            reply.code(502);
            return JSON.stringify({ error: 'fixture_exchange_result_lost' });
        }
    }
    return payload;
});
server.get('/test/cookie-probe', async (_request, reply) => {
    reply.header(
        'set-cookie',
        'browser-sso-third-party-probe=1; Path=/; Secure; SameSite=None; HttpOnly',
    );
    return reply.type('text/html').send('<p>Cookie probe</p>');
});
server.post('/test/pause-authorization', async () => {
    pauseNextAuthorization = true;
    pausedCallback = '';
    return { ok: true };
});
server.post('/test/drop-bootstrap', async () => {
    dropNextBootstrap = true;
    return { ok: true };
});
server.post('/test/pause-bootstrap', async () => {
    pauseNextBootstrap = true;
    pausedBootstrapUrl = '';
    return { ok: true };
});
server.get('/test/resume-bootstrap', async (_request, reply) => {
    const target = pausedBootstrapUrl;
    pausedBootstrapUrl = '';
    if (!target) {
        return reply.code(400).send('No paused ticket');
    }
    return reply.redirect(target);
});
server.get('/test/paused-callback', async () => ({ callback: pausedCallback }));
server.post<{ Body: { mode?: unknown } }>('/test/compatibility', async (request, reply) => {
    const mode = request.body.mode;
    if (mode !== 'normal' && mode !== '404' && mode !== 'disabled') {
        return reply.code(400).send({ ok: false });
    }
    if (compatGate) {
        await compatGate.close();
        compatGate = undefined;
    }
    capabilityMode = mode;
    if (mode !== 'normal') {
        compatGate = await createApp({
            config: {
                ...base,
                publicOrigin: browserSsoOrigin('compat'),
                directUse: true,
                browserSso: { mode: 'auto', allowInsecureLocalhost: !browserSsoHttps },
            },
            logger: false,
        });
        await compatGate.listen({ port: browserSsoListenPort('compat'), host: '127.0.0.1' });
    }
    return { ok: true };
});
server.get('/test/metrics', async () => ({ exchanges }));
server.post('/test/drop-exchange', async () => {
    dropNextExchange = true;
    return { ok: true };
});
server.post<{ Body: { site?: string; email?: string; allowed?: boolean } }>(
    '/test/grant',
    async (request, reply) => {
        const { site, email, allowed } = request.body;
        if (
            !['owner@example.com', 'other@example.com'].includes(email ?? '') ||
            typeof allowed !== 'boolean'
        ) {
            return reply.code(400).send({ ok: false });
        }
        for (const entry of config.sites) {
            if (site === '*' || entry.id === site) {
                if (allowed) {
                    entry.accessRules.set(email ?? '', new Set(['*']));
                } else {
                    entry.accessRules.delete(email ?? '');
                }
            }
        }
        return { ok: true };
    },
);
let ready = false;
server.get('/test/sso-ready', async (_request, reply): Promise<void> => {
    reply.code(ready ? 200 : 503).send({ ready });
});
const base = {
    rateLimitMax: 10000,
    serverUrl: issuer,
    upstreamUrl: 'http://127.0.0.1:45003',
    jwtSecret,
    previewSecret,
    browserSso: {
        mode: 'required',
        loginUi: process.env.MAGICSSO_E2E_SSO_APP_OWNED === 'true' ? 'app-owned' : 'hosted',
        allowInsecureLocalhost: !browserSsoHttps,
    },
} satisfies GateConfigInput;
const gateA = await createApp({ config: { ...base, publicOrigin: first }, logger: false });
const gateB = await createApp({
    config: {
        ...base,
        publicOrigin: second,
        mode: 'path-prefix',
        publicPathPrefix: '/private',
        namespace: '/_access',
    },
    logger: false,
});

async function shutdown(): Promise<void> {
    await Promise.allSettled([
        gateA.close(),
        gateB.close(),
        server.close(),
        ...(compatGate ? [compatGate.close()] : []),
    ]);
    upstream.closeAllConnections();
    await new Promise<void>((resolve) => {
        upstream.close(() => resolve());
    });
    await rm(directory, { recursive: true, force: true });
}
process.once('SIGTERM', () => {
    void shutdown();
});
process.once('SIGINT', () => {
    void shutdown();
});
try {
    await server.listen({ port: browserSsoListenPort('issuer'), host: '127.0.0.1' });
    await gateA.listen({ port: browserSsoListenPort('gate-a'), host: '127.0.0.1' });
    await gateB.listen({ port: browserSsoListenPort('gate-b'), host: '127.0.0.1' });
    ready = true;
} catch (error) {
    await shutdown();
    throw error;
}
