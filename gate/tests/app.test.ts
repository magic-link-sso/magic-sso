// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Wojciech Polak

import { SignJWT } from 'jose';
import { createServer, IncomingMessage, ServerResponse } from 'node:http';
import { Socket } from 'node:net';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createApp, type GateProxyServer } from '../src/app.js';

const testJwtSecret = 'test-jwt-secret-for-magic-gate-123456';
const testPreviewSecret = 'test-preview-secret-for-magic-gate-123';
const gateOrigin = 'http://private.example.com';
const ssoOrigin = 'http://sso.example.com';
const upstreamOrigin = 'http://private-upstream.internal';

afterEach(() => {
    vi.restoreAllMocks();
});

class FakeSocket extends Socket {
    readonly writes: string[] = [];
    destroyedByTest = false;

    override write(chunk: string | Uint8Array): boolean {
        this.writes.push(typeof chunk === 'string' ? chunk : Buffer.from(chunk).toString('utf8'));
        return true;
    }

    override destroy(): this {
        this.destroyedByTest = true;
        return this;
    }
}

interface ProxyCall {
    headers: Record<string, string>;
    requestHeaders: Record<string, string | string[] | undefined>;
    url: string | undefined;
}

type ProxyErrorListener = (
    error: Error,
    req: IncomingMessage,
    response: IncomingMessage | ServerResponse<IncomingMessage> | Socket,
) => void;

function createProxyStub(
    options: {
        onWeb?: (call: ProxyCall, response: ServerResponse<IncomingMessage>) => void;
        onWs?: (call: ProxyCall, socket: Socket) => void;
    } = {},
): {
    emitError: (
        error: Error,
        response: IncomingMessage | ServerResponse<IncomingMessage> | Socket,
    ) => void;
    proxy: GateProxyServer;
    webCalls: ProxyCall[];
    wsCalls: ProxyCall[];
} {
    const webCalls: ProxyCall[] = [];
    const wsCalls: ProxyCall[] = [];
    let errorListener: ProxyErrorListener | undefined;

    const proxy: GateProxyServer = {
        close(): void {
            // No-op for tests.
        },
        on(event, listener): void {
            if (event === 'error') {
                errorListener = listener;
            }
        },
        web(req, res, proxyOptions): void {
            const call = {
                headers: proxyOptions.headers,
                requestHeaders: { ...req.headers },
                url: req.url,
            };
            webCalls.push(call);

            if (typeof options.onWeb === 'function') {
                options.onWeb(call, res);
                return;
            }

            res.writeHead(200, {
                'content-type': 'application/json; charset=utf-8',
            });
            res.end(JSON.stringify({ ok: true, proxied: true }));
        },
        ws(req, socket, _head, proxyOptions): void {
            const call = {
                headers: proxyOptions.headers,
                requestHeaders: { ...req.headers },
                url: req.url,
            };
            wsCalls.push(call);

            if (typeof options.onWs === 'function') {
                options.onWs(call, socket);
            }
        },
    };

    return {
        emitError(error, response): void {
            if (typeof errorListener !== 'function') {
                throw new Error('Expected the proxy error listener to be registered.');
            }

            const req = new IncomingMessage(new Socket());
            errorListener(error, req, response);
        },
        proxy,
        webCalls,
        wsCalls,
    };
}

function setRemoteAddress(message: IncomingMessage, remoteAddress: string): void {
    Object.defineProperty(message.socket, 'remoteAddress', {
        configurable: true,
        value: remoteAddress,
    });
}

async function createAccessToken(options: {
    audience: string;
    email?: string;
    issuer: string;
    jti?: string;
}): Promise<string> {
    const secret = new TextEncoder().encode(testJwtSecret);
    return await new SignJWT({
        email: options.email ?? 'gate@example.com',
        jti: options.jti ?? 'gate-session-jti',
        scope: '*',
        siteId: 'private',
    })
        .setProtectedHeader({ alg: 'HS256' })
        .setAudience(options.audience)
        .setIssuer(options.issuer)
        .sign(secret);
}

async function createGateApp(
    options: {
        directUse?: boolean;
        invalidAudience?: boolean;
        logger?: false | { level: 'trace' | 'debug' | 'info' | 'warn' | 'error' | 'fatal' };
        publicOrigin?: string;
        rateLimitMax?: number;
        rateLimitWindowMs?: number;
        revokedSessionJtis?: readonly string[];
        proxyStub?: ReturnType<typeof createProxyStub>;
        trustProxy?: boolean;
    } = {},
) {
    const publicOrigin = options.publicOrigin ?? gateOrigin;
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockImplementation(async (input, init) => {
        const url = typeof input === 'string' ? input : input.toString();
        if (url === `${ssoOrigin}/signin`) {
            return new Response(JSON.stringify({ message: 'Verification email sent' }), {
                headers: {
                    'content-type': 'application/json',
                },
                status: 200,
            });
        }

        if (url.startsWith(`${ssoOrigin}/verify-email?`)) {
            return new Response(JSON.stringify({ email: 'gate@example.com' }), {
                headers: {
                    'content-type': 'application/json',
                },
                status: 200,
            });
        }

        if (url === `${ssoOrigin}/verify-email` && init?.method === 'POST') {
            const audience = options.invalidAudience ? 'http://wrong.example.com' : publicOrigin;
            return new Response(
                JSON.stringify({
                    accessToken: await createAccessToken({
                        audience,
                        issuer: ssoOrigin,
                    }),
                }),
                {
                    headers: {
                        'content-type': 'application/json',
                    },
                    status: 200,
                },
            );
        }

        if (url === `${ssoOrigin}/logout` && init?.method === 'POST') {
            return new Response(JSON.stringify({ message: 'Signed out' }), {
                headers: {
                    'content-type': 'application/json',
                },
                status: 200,
            });
        }

        if (url === `${ssoOrigin}/session-revocations/check` && init?.method === 'POST') {
            const previewSecretHeader = new Headers(init.headers).get('x-magic-sso-preview-secret');
            if (previewSecretHeader !== testPreviewSecret) {
                return new Response(JSON.stringify({ message: 'Forbidden' }), {
                    headers: {
                        'content-type': 'application/json',
                    },
                    status: 403,
                });
            }

            if (typeof init.body !== 'string') {
                throw new Error('Expected the revocation check request body to be JSON text.');
            }

            const body: unknown = JSON.parse(init.body);
            const jti = typeof body === 'object' && body !== null ? Reflect.get(body, 'jti') : null;
            return new Response(
                JSON.stringify({
                    revoked:
                        typeof jti === 'string' && (options.revokedSessionJtis ?? []).includes(jti),
                }),
                {
                    headers: {
                        'content-type': 'application/json',
                    },
                    status: 200,
                },
            );
        }

        throw new Error(`Unexpected fetch: ${url}`);
    });

    const proxyStub = options.proxyStub ?? createProxyStub();
    const app = await createApp({
        config: {
            directUse: options.directUse ?? false,
            jwtSecret: testJwtSecret,
            publicOrigin,
            previewSecret: testPreviewSecret,
            ...(typeof options.rateLimitMax === 'number'
                ? { rateLimitMax: options.rateLimitMax }
                : {}),
            ...(typeof options.rateLimitWindowMs === 'number'
                ? { rateLimitWindowMs: options.rateLimitWindowMs }
                : {}),
            requestTimeoutMs: 5_000,
            serverUrl: ssoOrigin,
            trustProxy: options.trustProxy ?? false,
            upstreamUrl: upstreamOrigin,
        },
        logger: options.logger ?? false,
        proxyFactory: () => proxyStub.proxy,
    });

    return {
        app,
        fetchMock,
        proxyStub,
    };
}

async function listenOnLocalhost(server: ReturnType<typeof createServer>): Promise<number> {
    await new Promise<void>((resolve, reject) => {
        server.once('error', reject);
        server.listen(0, '127.0.0.1', () => {
            server.off('error', reject);
            resolve();
        });
    });

    const address = server.address();
    if (typeof address !== 'object' || address === null) {
        throw new Error('Expected upstream server to listen on a TCP port.');
    }

    return address.port;
}

function mockSessionRevocationCheck(
    serverOrigin: string,
    options: {
        revoked?: boolean;
    } = {},
): void {
    vi.spyOn(globalThis, 'fetch').mockImplementation(async (input, init) => {
        const url = typeof input === 'string' ? input : input.toString();
        if (url === `${serverOrigin}/session-revocations/check` && init?.method === 'POST') {
            return new Response(JSON.stringify({ revoked: options.revoked ?? false }), {
                headers: {
                    'content-type': 'application/json',
                },
                status: 200,
            });
        }

        throw new Error(`Unexpected fetch: ${url}`);
    });
}

describe('magic gate routes', () => {
    it('renders the namespaced login page and does not proxy namespace conflicts', async () => {
        const { app, proxyStub } = await createGateApp();

        const response = await app.inject({
            method: 'GET',
            url: '/_magicgate/login?returnUrl=http://private.example.com/',
        });

        expect(response.statusCode).toBe(200);
        expect(response.body).toContain('Sign in');
        expect(response.body).toContain('referrerpolicy="same-origin"');
        expect(response.headers['cache-control']).toBe('no-store');
        expect(response.headers['content-security-policy']).toContain("frame-ancestors 'none'");
        expect(response.headers['permissions-policy']).toBe(
            'camera=(), geolocation=(), microphone=(), payment=(), usb=()',
        );
        expect(response.headers['referrer-policy']).toBe('same-origin');
        expect(response.headers['x-content-type-options']).toBe('nosniff');
        expect(response.headers['x-frame-options']).toBe('DENY');
        expect(proxyStub.webCalls).toHaveLength(0);

        await app.close();
    });

    it('ignores raw public login-page message query parameters', async () => {
        const { app } = await createGateApp();

        const response = await app.inject({
            method: 'GET',
            url: '/_magicgate/login?returnUrl=http://private.example.com/&message=Your+password+has+been+reset&status=success',
        });

        expect(response.statusCode).toBe(200);
        expect(response.body).not.toContain('Your password has been reset');

        await app.close();
    });

    it('redirects anonymous browser traffic to the local login route', async () => {
        const { app } = await createGateApp();

        const response = await app.inject({
            method: 'GET',
            url: '/',
        });

        expect(response.statusCode).toBe(302);
        expect(response.headers.location).toBe(
            '/_magicgate/login?returnUrl=http%3A%2F%2Fprivate.example.com%2F',
        );

        await app.close();
    });

    it('sets HSTS on Gate-served responses for trusted HTTPS requests', async () => {
        const proxyStub = createProxyStub();
        const { app } = await createGateApp({
            proxyStub,
            publicOrigin: 'https://private.example.com',
            trustProxy: true,
        });

        const response = await app.inject({
            method: 'GET',
            url: '/_magicgate/login?returnUrl=https%3A%2F%2Fprivate.example.com%2F',
            headers: {
                'x-forwarded-proto': 'https',
            },
        });

        expect(response.statusCode).toBe(200);
        expect(response.headers['strict-transport-security']).toBe(
            'max-age=15552000; includeSubDomains',
        );

        await app.close();
    });

    it('rate limits repeated requests from the same client IP', async () => {
        const { app } = await createGateApp({
            rateLimitMax: 1,
            rateLimitWindowMs: 60_000,
            trustProxy: true,
        });

        const firstResponse = await app.inject({
            headers: {
                'x-forwarded-for': '198.51.100.10',
            },
            method: 'GET',
            remoteAddress: '198.51.100.10',
            url: '/_magicgate/login?returnUrl=http://private.example.com/',
        });
        const secondResponse = await app.inject({
            headers: {
                'x-forwarded-for': '203.0.113.25',
            },
            method: 'GET',
            remoteAddress: '198.51.100.10',
            url: '/_magicgate/login?returnUrl=http://private.example.com/',
        });

        expect(firstResponse.statusCode).toBe(200);
        expect(secondResponse.statusCode).toBe(429);
        expect(secondResponse.json()).toEqual({ message: 'Too many requests.' });
        expect(Number.parseInt(secondResponse.headers['retry-after'] ?? '0', 10)).toBeGreaterThan(
            0,
        );

        await app.close();
    });

    it('ignores spoofed forwarded headers when rate limiting sign-in requests', async () => {
        const { app } = await createGateApp({
            rateLimitMax: 1,
            rateLimitWindowMs: 60_000,
            trustProxy: true,
        });

        const firstResponse = await app.inject({
            headers: {
                'content-type': 'application/x-www-form-urlencoded',
                origin: gateOrigin,
                'x-forwarded-for': '198.51.100.10',
            },
            method: 'POST',
            payload:
                'email=gate%40example.com&returnUrl=http%3A%2F%2Fprivate.example.com%2F&verifyUrl=http%3A%2F%2Fprivate.example.com%2F_magicgate%2Fverify-email',
            remoteAddress: '198.51.100.10',
            url: '/_magicgate/signin',
        });
        const secondResponse = await app.inject({
            headers: {
                'content-type': 'application/x-www-form-urlencoded',
                origin: gateOrigin,
                'x-forwarded-for': '203.0.113.25',
            },
            method: 'POST',
            payload:
                'email=gate%40example.com&returnUrl=http%3A%2F%2Fprivate.example.com%2F&verifyUrl=http%3A%2F%2Fprivate.example.com%2F_magicgate%2Fverify-email',
            remoteAddress: '198.51.100.10',
            url: '/_magicgate/signin',
        });

        expect(firstResponse.statusCode).toBe(302);
        expect(secondResponse.statusCode).toBe(429);
        expect(secondResponse.json()).toEqual({ message: 'Too many requests.' });

        await app.close();
    });

    it('returns 401 for anonymous JSON requests', async () => {
        const { app } = await createGateApp();

        const response = await app.inject({
            headers: {
                accept: 'application/json',
            },
            method: 'GET',
            url: '/api/whoami',
        });

        expect(response.statusCode).toBe(401);
        expect(response.json()).toEqual({
            message: 'Authentication required.',
        });

        await app.close();
    });

    it('scrubs unexpected route errors through the gate error handler', async () => {
        const { app } = await createGateApp();
        app.get('/boom', async (): Promise<void> => {
            throw new Error('boom leaked');
        });

        try {
            const jsonResponse = await app.inject({
                headers: {
                    accept: 'application/json',
                },
                method: 'GET',
                url: '/boom',
            });

            expect(jsonResponse.statusCode).toBe(500);
            expect(jsonResponse.json()).toEqual({ message: 'Internal Server Error' });
            expect(jsonResponse.body).not.toContain('boom leaked');

            const htmlResponse = await app.inject({
                headers: {
                    accept: 'text/html',
                },
                method: 'GET',
                url: '/boom',
            });

            expect(htmlResponse.statusCode).toBe(500);
            expect(htmlResponse.headers['content-type']).toContain('text/html');
            expect(htmlResponse.body).toContain('Internal Server Error');
            expect(htmlResponse.body).not.toContain('boom leaked');
        } finally {
            await app.close();
        }
    });

    it('logs proxy failures through the Fastify logger instead of console.error', async () => {
        const proxyStub = createProxyStub();
        const { app } = await createGateApp({
            logger: {
                level: 'error',
            },
            proxyStub,
        });
        const consoleErrorSpy = vi.spyOn(console, 'error').mockImplementation(() => undefined);
        const logErrorSpy = vi.spyOn(app.log, 'error');
        const socket = new FakeSocket();

        try {
            proxyStub.emitError(new Error('proxy failed'), socket);

            expect(logErrorSpy).toHaveBeenCalled();
            expect(consoleErrorSpy).not.toHaveBeenCalled();
            expect(socket.writes.join('')).toContain('502 Bad Gateway');
            expect(socket.destroyedByTest).toBe(true);
        } finally {
            await app.close();
        }
    });

    it('stores the verify-email token cookie and completes confirmation without exposing the token in HTML', async () => {
        const { app, fetchMock } = await createGateApp();

        const pageResponse = await app.inject({
            method: 'GET',
            url: '/_magicgate/verify-email?token=test-token&returnUrl=http://private.example.com/',
        });
        const csrfCookie = pageResponse.cookies.find(
            (cookie) => cookie.name === 'magic-sso.verify-csrf',
        );
        const tokenCookie = pageResponse.cookies.find(
            (cookie) => cookie.name === 'magic-sso.verify-token',
        );
        const csrfTokenMatch = pageResponse.body.match(/name="csrfToken" value="([^"]+)"/u);

        expect(pageResponse.statusCode).toBe(200);
        expect(pageResponse.body).toContain('Continue sign-in');
        expect(pageResponse.headers['cache-control']).toBe('no-store');
        expect(pageResponse.headers['referrer-policy']).toBe('no-referrer');
        expect(pageResponse.headers['content-security-policy']).toContain("default-src 'self'");
        expect(pageResponse.body).toContain(
            '<script src="/_magicgate/assets/verify-email-page.js"></script>',
        );
        expect(pageResponse.body).toContain('referrerpolicy="same-origin"');
        expect(pageResponse.body).not.toContain('name="token"');
        expect(csrfCookie?.value).toBeTruthy();
        expect(tokenCookie?.value).toBe('test-token');
        expect(tokenCookie?.httpOnly).toBe(true);
        expect(tokenCookie?.path).toBe('/_magicgate/verify-email');
        expect(csrfTokenMatch?.[1]).toBeTruthy();
        expect(fetchMock).toHaveBeenCalledWith(
            new URL(`${ssoOrigin}/verify-email?token=test-token`),
            expect.objectContaining({
                headers: expect.objectContaining({
                    accept: 'application/json',
                    'x-magic-sso-preview-secret': testPreviewSecret,
                }),
                redirect: 'error',
            }),
        );

        const verifyResponse = await app.inject({
            headers: {
                'content-type': 'application/x-www-form-urlencoded',
                cookie: `magic-sso.verify-csrf=${csrfCookie?.value ?? ''}; magic-sso.verify-token=${tokenCookie?.value ?? ''}`,
                origin: gateOrigin,
            },
            method: 'POST',
            payload: `csrfToken=${encodeURIComponent(csrfTokenMatch?.[1] ?? '')}&returnUrl=${encodeURIComponent('http://private.example.com/')}`,
            url: '/_magicgate/verify-email',
        });

        const authCookie = verifyResponse.cookies.find((cookie) => cookie.name === 'magic-sso');
        expect(verifyResponse.statusCode).toBe(302);
        expect(verifyResponse.headers.location).toBe('http://private.example.com/');
        expect(authCookie?.httpOnly).toBe(true);
        expect(fetchMock).toHaveBeenCalledWith(
            new URL('/verify-email', ssoOrigin),
            expect.objectContaining({
                method: 'POST',
                redirect: 'error',
            }),
        );

        await app.close();
    });

    it('rejects cross-site verify-email POST submissions even with a valid csrf pair', async () => {
        const { app, fetchMock } = await createGateApp();

        const pageResponse = await app.inject({
            method: 'GET',
            url: '/_magicgate/verify-email?token=test-token&returnUrl=http://private.example.com/',
        });
        const csrfCookie = pageResponse.cookies.find(
            (cookie) => cookie.name === 'magic-sso.verify-csrf',
        );
        const csrfTokenMatch = pageResponse.body.match(/name="csrfToken" value="([^"]+)"/u);

        const verifyResponse = await app.inject({
            headers: {
                'content-type': 'application/x-www-form-urlencoded',
                cookie: `magic-sso.verify-csrf=${csrfCookie?.value ?? ''}; magic-sso.verify-token=${pageResponse.cookies.find((cookie) => cookie.name === 'magic-sso.verify-token')?.value ?? ''}`,
                origin: 'http://evil.example.com',
            },
            method: 'POST',
            payload: `csrfToken=${encodeURIComponent(csrfTokenMatch?.[1] ?? '')}&returnUrl=${encodeURIComponent('http://private.example.com/')}`,
            url: '/_magicgate/verify-email',
        });

        expect(verifyResponse.statusCode).toBe(403);
        expect(verifyResponse.json()).toEqual({ message: 'Forbidden' });
        expect(fetchMock).not.toHaveBeenCalledWith(
            new URL('/verify-email', ssoOrigin),
            expect.objectContaining({
                method: 'POST',
            }),
        );

        await app.close();
    });

    it('allows same-origin verify-email POST submissions when the browser omits origin and referer', async () => {
        const { app, fetchMock } = await createGateApp();

        const pageResponse = await app.inject({
            method: 'GET',
            url: '/_magicgate/verify-email?token=test-token&returnUrl=http://private.example.com/',
        });
        const csrfCookie = pageResponse.cookies.find(
            (cookie) => cookie.name === 'magic-sso.verify-csrf',
        );
        const csrfTokenMatch = pageResponse.body.match(/name="csrfToken" value="([^"]+)"/u);

        const verifyResponse = await app.inject({
            headers: {
                'content-type': 'application/x-www-form-urlencoded',
                cookie: `magic-sso.verify-csrf=${csrfCookie?.value ?? ''}; magic-sso.verify-token=${pageResponse.cookies.find((cookie) => cookie.name === 'magic-sso.verify-token')?.value ?? ''}`,
                'sec-fetch-site': 'same-origin',
            },
            method: 'POST',
            payload: `csrfToken=${encodeURIComponent(csrfTokenMatch?.[1] ?? '')}&returnUrl=${encodeURIComponent('http://private.example.com/')}`,
            url: '/_magicgate/verify-email',
        });

        const authCookie = verifyResponse.cookies.find((cookie) => cookie.name === 'magic-sso');
        expect(verifyResponse.statusCode).toBe(302);
        expect(verifyResponse.headers.location).toBe('http://private.example.com/');
        expect(authCookie?.httpOnly).toBe(true);
        expect(fetchMock).toHaveBeenCalledWith(
            new URL('/verify-email', ssoOrigin),
            expect.objectContaining({
                method: 'POST',
                redirect: 'error',
            }),
        );

        await app.close();
    });

    it('serves a verify-email page script that removes tokens from the browser url', async () => {
        const { app } = await createGateApp();

        const response = await app.inject({
            method: 'GET',
            url: '/_magicgate/assets/verify-email-page.js',
        });

        expect(response.statusCode).toBe(200);
        expect(response.headers['content-type']).toContain('text/javascript');
        expect(response.body).toContain("window.history.replaceState(null, '', nextUrl);");
        expect(response.body).toContain("currentUrl.searchParams.delete('token');");

        await app.close();
    });

    it('rejects cross-site sign-in POST submissions before contacting the SSO server', async () => {
        const { app, fetchMock } = await createGateApp();

        const response = await app.inject({
            headers: {
                'content-type': 'application/x-www-form-urlencoded',
                origin: 'http://evil.example.com',
            },
            method: 'POST',
            payload:
                'email=gate%40example.com&returnUrl=http%3A%2F%2Fprivate.example.com%2F&verifyUrl=http%3A%2F%2Fprivate.example.com%2F_magicgate%2Fverify-email',
            url: '/_magicgate/signin',
        });

        expect(response.statusCode).toBe(403);
        expect(response.json()).toEqual({ message: 'Forbidden' });
        expect(fetchMock).not.toHaveBeenCalledWith(`${ssoOrigin}/signin`, expect.anything());

        await app.close();
    });

    it('allows same-origin sign-in POST submissions', async () => {
        const { app, fetchMock } = await createGateApp();

        const response = await app.inject({
            headers: {
                'content-type': 'application/x-www-form-urlencoded',
                origin: gateOrigin,
            },
            method: 'POST',
            payload:
                'email=gate%40example.com&returnUrl=http%3A%2F%2Fprivate.example.com%2F&verifyUrl=http%3A%2F%2Fprivate.example.com%2F_magicgate%2Fverify-email',
            url: '/_magicgate/signin',
        });

        expect(response.statusCode).toBe(302);
        const location = response.headers.location;
        if (typeof location !== 'string') {
            throw new Error('Expected a redirect target.');
        }
        const redirectUrl = new URL(location, gateOrigin);
        expect(redirectUrl.pathname).toBe('/_magicgate/login');
        expect(redirectUrl.searchParams.get('returnUrl')).toBe('http://private.example.com/');
        expect(redirectUrl.searchParams.get('result')).toBe('signin-email-sent');
        expect(redirectUrl.searchParams.get('status')).toBeNull();
        expect(redirectUrl.searchParams.get('message')).toBeNull();
        expect(fetchMock).toHaveBeenCalledWith(
            new URL('/signin', ssoOrigin),
            expect.objectContaining({
                method: 'POST',
                redirect: 'error',
            }),
        );

        await app.close();
    });

    it('allows same-origin sign-in POST submissions when the browser omits origin and referer', async () => {
        const { app, fetchMock } = await createGateApp();

        const response = await app.inject({
            headers: {
                'content-type': 'application/x-www-form-urlencoded',
                'sec-fetch-site': 'same-origin',
            },
            method: 'POST',
            payload:
                'email=gate%40example.com&returnUrl=http%3A%2F%2Fprivate.example.com%2F&verifyUrl=http%3A%2F%2Fprivate.example.com%2F_magicgate%2Fverify-email',
            url: '/_magicgate/signin',
        });

        expect(response.statusCode).toBe(302);
        const location = response.headers.location;
        if (typeof location !== 'string') {
            throw new Error('Expected a redirect target.');
        }
        const redirectUrl = new URL(location, gateOrigin);
        expect(redirectUrl.pathname).toBe('/_magicgate/login');
        expect(redirectUrl.searchParams.get('returnUrl')).toBe('http://private.example.com/');
        expect(redirectUrl.searchParams.get('result')).toBe('signin-email-sent');
        expect(redirectUrl.searchParams.get('status')).toBeNull();
        expect(redirectUrl.searchParams.get('message')).toBeNull();
        expect(fetchMock).toHaveBeenCalledWith(
            new URL('/signin', ssoOrigin),
            expect.objectContaining({
                method: 'POST',
                redirect: 'error',
            }),
        );

        await app.close();
    });

    it('ignores tampered verifyUrl values on sign-in requests', async () => {
        const { app, fetchMock } = await createGateApp();

        const response = await app.inject({
            headers: {
                'content-type': 'application/x-www-form-urlencoded',
                origin: gateOrigin,
            },
            method: 'POST',
            payload:
                'email=gate%40example.com&returnUrl=http%3A%2F%2Fprivate.example.com%2Fdashboard&verifyUrl=https%3A%2F%2Fevil.example.com%2Fcapture',
            url: '/_magicgate/signin',
        });

        expect(response.statusCode).toBe(302);
        const fetchCall = fetchMock.mock.calls.find(
            ([input]) => input.toString() === `${ssoOrigin}/signin`,
        );
        const requestInit = fetchCall?.[1];
        if (typeof requestInit !== 'object' || requestInit === null) {
            throw new Error('Expected a sign-in fetch payload.');
        }

        const body = requestInit.body;
        if (typeof body !== 'string') {
            throw new Error('Expected the sign-in fetch body to be JSON.');
        }

        expect(JSON.parse(body)).toEqual({
            email: 'gate@example.com',
            returnUrl: 'http://private.example.com/dashboard',
            verifyUrl:
                'http://private.example.com/_magicgate/verify-email?returnUrl=http%3A%2F%2Fprivate.example.com%2Fdashboard',
        });

        await app.close();
    });

    it('rejects forwarded-header spoofing on same-origin sign-in checks', async () => {
        const { app, fetchMock } = await createGateApp({
            trustProxy: true,
        });

        const response = await app.inject({
            headers: {
                'content-type': 'application/x-www-form-urlencoded',
                origin: 'https://attacker.example.com',
                'x-forwarded-host': 'attacker.example.com',
                'x-forwarded-proto': 'https',
            },
            method: 'POST',
            payload: 'email=gate%40example.com&returnUrl=http%3A%2F%2Fprivate.example.com%2F',
            url: '/_magicgate/signin',
        });

        expect(response.statusCode).toBe(403);
        expect(response.json()).toEqual({ message: 'Forbidden' });
        expect(fetchMock).not.toHaveBeenCalledWith(
            new URL('/signin', ssoOrigin),
            expect.anything(),
        );

        await app.close();
    });

    it('proxies authenticated HTML, JSON, and SSE with forwarded identity headers', async () => {
        const proxyStub = createProxyStub({
            onWeb(call, response): void {
                if (call.url === '/api/whoami') {
                    response.writeHead(200, {
                        'content-type': 'application/json; charset=utf-8',
                    });
                    response.end(
                        JSON.stringify({
                            email: call.headers['x-magic-sso-user-email'],
                            proxied: true,
                        }),
                    );
                    return;
                }

                if (call.url === '/events') {
                    response.writeHead(200, {
                        'content-type': 'text/event-stream; charset=utf-8',
                    });
                    response.end(
                        `event: ready\ndata: {"email":"${call.headers['x-magic-sso-user-email']}"}\n\n`,
                    );
                    return;
                }

                response.writeHead(200, {
                    'content-type': 'text/html; charset=utf-8',
                });
                response.end(
                    `<!doctype html><html><body><h1>Your Magic Gate session is locked in and proxied.</h1><p>${call.headers['x-magic-sso-user-email']}</p></body></html>`,
                );
            },
        });
        const { app } = await createGateApp({ proxyStub });
        const accessToken = await createAccessToken({
            audience: gateOrigin,
            issuer: ssoOrigin,
        });
        const authCookie = `magic-sso=${encodeURIComponent(accessToken)}`;

        const htmlResponse = await app.inject({
            headers: {
                cookie: `${authCookie}; upstream-session=upstream-123`,
                forwarded: 'for=198.51.100.10;proto=https;host=attacker.example.com',
                'x-magic-sso-user-email': 'attacker@example.com',
                'x-forwarded-for': '198.51.100.10',
                'x-forwarded-host': 'attacker.example.com',
                'x-forwarded-proto': 'https',
                'x-real-ip': '198.51.100.10',
            },
            method: 'GET',
            url: '/',
        });
        expect(htmlResponse.statusCode).toBe(200);
        expect(htmlResponse.body).toContain('Your Magic Gate session is locked in and proxied.');
        expect(htmlResponse.body).toContain('gate@example.com');
        expect(htmlResponse.headers['permissions-policy']).toBe(
            'camera=(), geolocation=(), microphone=(), payment=(), usb=()',
        );
        expect(htmlResponse.headers['referrer-policy']).toBe('same-origin');
        expect(htmlResponse.headers['x-content-type-options']).toBe('nosniff');
        expect(htmlResponse.headers['x-frame-options']).toBe('DENY');

        const apiResponse = await app.inject({
            headers: {
                accept: 'application/json',
                cookie: authCookie,
            },
            method: 'GET',
            url: '/api/whoami',
        });
        expect(apiResponse.statusCode).toBe(200);
        expect(apiResponse.json()).toEqual({
            email: 'gate@example.com',
            proxied: true,
        });

        const sseResponse = await app.inject({
            headers: {
                cookie: authCookie,
            },
            method: 'GET',
            url: '/events',
        });
        expect(sseResponse.statusCode).toBe(200);
        expect(sseResponse.body).toContain('event: ready');
        expect(sseResponse.body).toContain('gate@example.com');

        expect(proxyStub.webCalls).toHaveLength(3);
        expect(proxyStub.webCalls[0]?.headers['x-magic-sso-user-email']).toBe('gate@example.com');
        expect(proxyStub.webCalls[0]?.requestHeaders.cookie).toBe('upstream-session=upstream-123');
        expect(proxyStub.webCalls[0]?.requestHeaders['x-magic-sso-user-email']).toBeUndefined();
        expect(proxyStub.webCalls[0]?.requestHeaders.forwarded).toBeUndefined();
        expect(proxyStub.webCalls[0]?.requestHeaders['x-forwarded-for']).toBeUndefined();
        expect(proxyStub.webCalls[0]?.requestHeaders['x-forwarded-host']).toBeUndefined();
        expect(proxyStub.webCalls[0]?.requestHeaders['x-forwarded-proto']).toBeUndefined();
        expect(proxyStub.webCalls[0]?.requestHeaders['x-real-ip']).toBeUndefined();

        await app.close();
    });

    it('rejects revoked sessions during proxy and session checks', async () => {
        const revokedSessionJti = 'revoked-session-jti';
        const { app, proxyStub } = await createGateApp({
            revokedSessionJtis: [revokedSessionJti],
        });
        const accessToken = await createAccessToken({
            audience: gateOrigin,
            issuer: ssoOrigin,
            jti: revokedSessionJti,
        });

        const protectedResponse = await app.inject({
            headers: {
                cookie: `magic-sso=${encodeURIComponent(accessToken)}`,
            },
            method: 'GET',
            url: '/',
        });
        expect(protectedResponse.statusCode).toBe(302);
        expect(protectedResponse.headers.location).toBe(
            '/_magicgate/login?returnUrl=http%3A%2F%2Fprivate.example.com%2F',
        );

        const sessionResponse = await app.inject({
            headers: {
                cookie: `magic-sso=${encodeURIComponent(accessToken)}`,
            },
            method: 'GET',
            url: '/_magicgate/session',
        });
        expect(sessionResponse.statusCode).toBe(200);
        expect(sessionResponse.json()).toEqual({
            authenticated: false,
        });

        expect(proxyStub.webCalls).toHaveLength(0);

        await app.close();
    });

    it('revokes the current session on the server before clearing the gate cookie', async () => {
        const { app, fetchMock } = await createGateApp();
        const accessToken = await createAccessToken({
            audience: gateOrigin,
            issuer: ssoOrigin,
        });

        const response = await app.inject({
            headers: {
                cookie: `magic-sso=${encodeURIComponent(accessToken)}`,
                origin: gateOrigin,
            },
            method: 'POST',
            url: '/_magicgate/logout',
        });

        const logoutCall = fetchMock.mock.calls.find(
            ([input, init]) =>
                input.toString() === `${ssoOrigin}/logout` && init?.method === 'POST',
        );

        expect(response.statusCode).toBe(302);
        expect(response.headers.location).toBe('/');
        expect(response.cookies.some((cookie) => cookie.name === 'magic-sso')).toBe(true);
        expect(logoutCall).toBeDefined();

        const logoutHeaders = new Headers(logoutCall?.[1]?.headers);
        expect(logoutHeaders.get('authorization')).toBe(`Bearer ${accessToken}`);
        expect(logoutHeaders.get('accept')).toBe('application/json');

        await app.close();
    });

    it('adds baseline transport headers to proxied HTTPS responses', async () => {
        const proxyStub = createProxyStub();
        const { app } = await createGateApp({
            proxyStub,
            publicOrigin: 'https://private.example.com',
            trustProxy: true,
        });
        const accessToken = await createAccessToken({
            audience: 'https://private.example.com',
            issuer: ssoOrigin,
        });

        const response = await app.inject({
            method: 'GET',
            url: '/',
            headers: {
                cookie: `magic-sso=${encodeURIComponent(accessToken)}`,
                'x-forwarded-proto': 'https',
            },
        });

        expect(response.statusCode).toBe(200);
        expect(response.headers['permissions-policy']).toBe(
            'camera=(), geolocation=(), microphone=(), payment=(), usb=()',
        );
        expect(response.headers['referrer-policy']).toBe('same-origin');
        expect(response.headers['x-content-type-options']).toBe('nosniff');
        expect(response.headers['x-frame-options']).toBe('DENY');
        expect(response.headers['strict-transport-security']).toBe(
            'max-age=15552000; includeSubDomains',
        );

        await app.close();
    });

    it('keeps gate security headers when the upstream response conflicts', async () => {
        mockSessionRevocationCheck('https://sso.example.com');
        const upstream = createServer((_request, response) => {
            response.writeHead(200, {
                'content-type': 'text/html; charset=utf-8',
                'permissions-policy': 'camera=*',
                'referrer-policy': 'unsafe-url',
                server: 'upstream-test-server',
                'strict-transport-security': 'max-age=1',
                'x-content-type-options': 'sniff',
                'x-frame-options': 'SAMEORIGIN',
            });
            response.end('<!doctype html><html><body>proxied</body></html>');
        });
        const upstreamPort = await listenOnLocalhost(upstream);
        const app = await createApp({
            config: {
                jwtSecret: testJwtSecret,
                publicOrigin: 'https://private.example.com',
                previewSecret: testPreviewSecret,
                requestTimeoutMs: 5_000,
                serverUrl: 'https://sso.example.com',
                trustProxy: true,
                upstreamUrl: `http://127.0.0.1:${upstreamPort}`,
            },
            logger: false,
        });
        const accessToken = await createAccessToken({
            audience: 'https://private.example.com',
            issuer: 'https://sso.example.com',
        });

        try {
            const response = await app.inject({
                method: 'GET',
                url: '/',
                headers: {
                    cookie: `magic-sso=${encodeURIComponent(accessToken)}`,
                    'x-forwarded-proto': 'https',
                },
            });

            expect(response.statusCode).toBe(200);
            expect(response.headers['permissions-policy']).toBe(
                'camera=(), geolocation=(), microphone=(), payment=(), usb=()',
            );
            expect(response.headers['referrer-policy']).toBe('same-origin');
            expect(response.headers.server).toBeUndefined();
            expect(response.headers['strict-transport-security']).toBe(
                'max-age=15552000; includeSubDomains',
            );
            expect(response.headers['x-content-type-options']).toBe('nosniff');
            expect(response.headers['x-frame-options']).toBe('DENY');
        } finally {
            await app.close();
            await new Promise<void>((resolve, reject) => {
                upstream.close((error) => {
                    if (error) {
                        reject(error);
                        return;
                    }
                    resolve();
                });
            });
        }
    });

    it('filters upstream cookies that collide with gate cookie names', async () => {
        mockSessionRevocationCheck(ssoOrigin);
        const upstream = createServer((_request, response) => {
            response.writeHead(200, {
                'content-type': 'application/json; charset=utf-8',
                'set-cookie': [
                    'magic-sso=upstream-shadow; Path=/; HttpOnly',
                    'magic-sso.verify-token=shadow-token; Path=/_magicgate/verify-email; HttpOnly',
                    'magic-sso.verify-csrf=shadow-csrf; Path=/_magicgate/verify-email; HttpOnly',
                    'upstream-session=upstream-123; Path=/; HttpOnly',
                ],
            });
            response.end(JSON.stringify({ ok: true }));
        });
        const upstreamPort = await listenOnLocalhost(upstream);
        const app = await createApp({
            config: {
                jwtSecret: testJwtSecret,
                publicOrigin: gateOrigin,
                previewSecret: testPreviewSecret,
                requestTimeoutMs: 5_000,
                serverUrl: ssoOrigin,
                upstreamUrl: `http://127.0.0.1:${upstreamPort}`,
            },
            logger: false,
        });
        const accessToken = await createAccessToken({
            audience: gateOrigin,
            issuer: ssoOrigin,
        });

        try {
            const response = await app.inject({
                method: 'GET',
                url: '/',
                headers: {
                    cookie: `magic-sso=${encodeURIComponent(accessToken)}`,
                },
            });

            expect(response.statusCode).toBe(200);
            expect(response.cookies.map((cookie) => cookie.name)).toEqual(['upstream-session']);
            expect(response.cookies[0]?.value).toBe('upstream-123');
        } finally {
            await app.close();
            await new Promise<void>((resolve, reject) => {
                upstream.close((error) => {
                    if (error) {
                        reject(error);
                        return;
                    }
                    resolve();
                });
            });
        }
    });

    it('blocks verify-email tokens that are bound to a different audience', async () => {
        const { app } = await createGateApp({
            invalidAudience: true,
        });

        const pageResponse = await app.inject({
            method: 'GET',
            url: '/_magicgate/verify-email?token=test-token&returnUrl=http://private.example.com/',
        });
        const csrfCookie = pageResponse.cookies.find(
            (cookie) => cookie.name === 'magic-sso.verify-csrf',
        );
        const csrfTokenMatch = pageResponse.body.match(/name="csrfToken" value="([^"]+)"/u);

        const verifyResponse = await app.inject({
            headers: {
                'content-type': 'application/x-www-form-urlencoded',
                cookie: `magic-sso.verify-csrf=${csrfCookie?.value ?? ''}; magic-sso.verify-token=${pageResponse.cookies.find((cookie) => cookie.name === 'magic-sso.verify-token')?.value ?? ''}`,
                origin: gateOrigin,
            },
            method: 'POST',
            payload: `csrfToken=${encodeURIComponent(csrfTokenMatch?.[1] ?? '')}&returnUrl=${encodeURIComponent('http://private.example.com/')}`,
            url: '/_magicgate/verify-email',
        });

        expect(verifyResponse.statusCode).toBe(302);
        expect(verifyResponse.headers.location).toContain('error=session-verification-failed');

        await app.close();
    });

    it('routes websocket upgrades through the proxy only when the auth cookie is valid', async () => {
        const proxyStub = createProxyStub({
            onWs(call, socket): void {
                socket.write(
                    JSON.stringify({
                        email: call.headers['x-magic-sso-user-email'],
                        via: 'websocket',
                    }),
                );
            },
        });
        const { app } = await createGateApp({ proxyStub });
        const accessToken = await createAccessToken({
            audience: gateOrigin,
            issuer: ssoOrigin,
        });

        const upgradeHandlers = app.server.listeners('upgrade');
        const upgradeHandler = upgradeHandlers[0];
        if (typeof upgradeHandler !== 'function') {
            throw new Error('Expected Gate to register an upgrade handler.');
        }

        const request = new IncomingMessage(new Socket());
        request.url = '/ws';
        request.headers.cookie = `magic-sso=${encodeURIComponent(accessToken)}; upstream-session=upstream-123`;
        request.headers.forwarded = 'for=198.51.100.10;proto=https;host=attacker.example.com';
        request.headers.origin = gateOrigin;
        request.headers['x-magic-sso-user-email'] = 'attacker@example.com';
        request.headers['x-forwarded-for'] = '198.51.100.10';
        request.headers['x-forwarded-host'] = 'attacker.example.com';
        request.headers['x-forwarded-proto'] = 'https';
        request.headers['x-real-ip'] = '198.51.100.10';
        const socket = new FakeSocket();

        await upgradeHandler(request, socket, Buffer.alloc(0));

        expect(proxyStub.wsCalls).toHaveLength(1);
        expect(proxyStub.wsCalls[0]?.url).toBe('/ws');
        expect(proxyStub.wsCalls[0]?.headers['x-magic-sso-user-email']).toBe('gate@example.com');
        expect(proxyStub.wsCalls[0]?.requestHeaders.cookie).toBe('upstream-session=upstream-123');
        expect(proxyStub.wsCalls[0]?.requestHeaders['x-magic-sso-user-email']).toBeUndefined();
        expect(proxyStub.wsCalls[0]?.requestHeaders.forwarded).toBeUndefined();
        expect(proxyStub.wsCalls[0]?.requestHeaders['x-forwarded-for']).toBeUndefined();
        expect(proxyStub.wsCalls[0]?.requestHeaders['x-forwarded-host']).toBeUndefined();
        expect(proxyStub.wsCalls[0]?.requestHeaders['x-forwarded-proto']).toBeUndefined();
        expect(proxyStub.wsCalls[0]?.requestHeaders['x-real-ip']).toBeUndefined();
        expect(socket.writes.join('')).toContain('gate@example.com');

        const anonymousRequest = new IncomingMessage(new Socket());
        anonymousRequest.url = '/ws';
        anonymousRequest.headers.origin = gateOrigin;
        const anonymousSocket = new FakeSocket();

        await upgradeHandler(anonymousRequest, anonymousSocket, Buffer.alloc(0));

        expect(proxyStub.wsCalls).toHaveLength(1);
        expect(anonymousSocket.writes.join('')).toContain('401 Unauthorized');

        const crossSiteRequest = new IncomingMessage(new Socket());
        crossSiteRequest.url = '/ws';
        crossSiteRequest.headers.cookie = `magic-sso=${encodeURIComponent(accessToken)}`;
        crossSiteRequest.headers.origin = 'http://evil.example.com';
        const crossSiteSocket = new FakeSocket();

        await upgradeHandler(crossSiteRequest, crossSiteSocket, Buffer.alloc(0));

        expect(proxyStub.wsCalls).toHaveLength(1);
        expect(crossSiteSocket.writes.join('')).toContain('403 Forbidden');

        await app.close();
    });

    it('rate limits websocket upgrades from the same client IP', async () => {
        const proxyStub = createProxyStub();
        const { app } = await createGateApp({
            proxyStub,
            rateLimitMax: 1,
            rateLimitWindowMs: 60_000,
            trustProxy: true,
        });
        const accessToken = await createAccessToken({
            audience: gateOrigin,
            issuer: ssoOrigin,
        });

        const upgradeHandlers = app.server.listeners('upgrade');
        const upgradeHandler = upgradeHandlers[0];
        if (typeof upgradeHandler !== 'function') {
            throw new Error('Expected Gate to register an upgrade handler.');
        }

        const firstRequest = new IncomingMessage(new Socket());
        firstRequest.url = '/ws';
        firstRequest.headers.cookie = `magic-sso=${encodeURIComponent(accessToken)}`;
        firstRequest.headers.origin = gateOrigin;
        firstRequest.headers['x-forwarded-for'] = '198.51.100.10';
        setRemoteAddress(firstRequest, '198.51.100.10');
        const firstSocket = new FakeSocket();

        await upgradeHandler(firstRequest, firstSocket, Buffer.alloc(0));

        expect(proxyStub.wsCalls).toHaveLength(1);

        const secondRequest = new IncomingMessage(new Socket());
        secondRequest.url = '/ws';
        secondRequest.headers.cookie = `magic-sso=${encodeURIComponent(accessToken)}`;
        secondRequest.headers.origin = gateOrigin;
        secondRequest.headers['x-forwarded-for'] = '203.0.113.25';
        setRemoteAddress(secondRequest, '198.51.100.10');
        const secondSocket = new FakeSocket();

        await upgradeHandler(secondRequest, secondSocket, Buffer.alloc(0));

        expect(proxyStub.wsCalls).toHaveLength(1);
        expect(secondSocket.writes.join('')).toContain('429 Too Many Requests');
        expect(secondSocket.writes.join('')).toContain('Too many requests.');

        await app.close();
    });

    it('builds a direct hosted sign-in target when direct mode is enabled', async () => {
        const { app } = await createGateApp({
            directUse: true,
        });

        const response = await app.inject({
            method: 'GET',
            url: '/',
        });

        expect(response.statusCode).toBe(302);
        const location = response.headers.location;
        if (typeof location !== 'string') {
            throw new Error('Expected a redirect target.');
        }

        const redirectUrl = new URL(location);
        expect(redirectUrl.origin).toBe(ssoOrigin);
        expect(redirectUrl.pathname).toBe('/signin');
        expect(redirectUrl.searchParams.get('verifyUrl')).toBe(
            'http://private.example.com/_magicgate/verify-email?returnUrl=http%3A%2F%2Fprivate.example.com%2F',
        );

        await app.close();
    });

    it('marks the session summary endpoint as non-cacheable', async () => {
        const { app } = await createGateApp();
        const accessToken = await createAccessToken({
            audience: gateOrigin,
            issuer: ssoOrigin,
        });

        const response = await app.inject({
            headers: {
                cookie: `magic-sso=${encodeURIComponent(accessToken)}`,
            },
            method: 'GET',
            url: '/_magicgate/session',
        });

        expect(response.statusCode).toBe(200);
        expect(response.headers['cache-control']).toBe('no-store');
        expect(response.headers.pragma).toBe('no-cache');
        expect(response.json()).toEqual({
            authenticated: true,
            email: 'gate@example.com',
            scope: '*',
            siteId: 'private',
        });

        await app.close();
    });
});
