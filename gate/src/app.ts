// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Wojciech Polak

import cookie from '@fastify/cookie';
import formbody from '@fastify/formbody';
import Fastify, {
    type FastifyInstance,
    type FastifyReply,
    type FastifyRequest,
    type RouteHandlerMethod,
} from 'fastify';
import { protectedBadgeUrl, signinBadgeUrl } from 'magic-sso-example-ui';
import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import {
    IncomingMessage,
    type IncomingHttpHeaders,
    type OutgoingHttpHeaders,
    ServerResponse,
    request as createHttpRequest,
} from 'node:http';
import { request as createHttpsRequest } from 'node:https';
import { Socket } from 'node:net';
import { fileURLToPath } from 'node:url';
import {
    buildAuthCookieOptions,
    buildLoginTarget,
    buildVerifyUrl,
    deriveVerifyCsrfSecret,
    getJwtSecret,
    getLoginErrorMessage,
    readCookieValue,
    verifyAuthToken,
    verifyRequestAuth,
    type AuthPayload,
} from './auth.js';
import {
    buildGatePath,
    buildPublicUrl,
    collectGateTargetWarnings,
    isNamespacePath,
    normaliseReturnUrl,
    loadConfig,
    resolveGateConfig,
    stripPublicPathPrefix,
    type GateConfig,
    type GateConfigInput,
} from './config.js';
import {
    renderLoginPage,
    renderVerifyEmailConfirmationPage,
    type LoginPageMessage,
} from './html.js';
import { verifyEmailPageScript } from './verifyEmailPageScript.js';
import { createGateRateLimiter } from './rateLimit.js';

interface SignInBody {
    email?: string;
    returnUrl?: string;
}

interface LoginQuery {
    error?: string;
    result?: string;
    returnUrl?: string;
}

interface VerifyEmailQuery {
    returnUrl?: string;
    token?: string;
}

interface VerifyEmailBody {
    csrfToken?: string;
    returnUrl?: string;
    token?: string;
}

interface VerifyEmailResponse {
    accessToken: string;
}

interface VerifyEmailPreviewResponse {
    email: string;
}

interface SignInSuccessResponse {
    message: string;
}

interface GateProxyOptions {
    blockedResponseCookieNames: readonly string[];
    changeOrigin: boolean;
    forwardedProto: string;
    headers: Record<string, string>;
    target: string;
    xfwd: boolean;
}

export interface CreateAppOptions {
    config?: GateConfigInput;
    logger?: false | { level: 'trace' | 'debug' | 'info' | 'warn' | 'error' | 'fatal' };
    proxyFactory?: () => GateProxyServer;
}

export interface GateProxyServer {
    close(): void;
    on(
        event: 'error',
        listener: (
            error: Error,
            req: IncomingMessage,
            response: IncomingMessage | ServerResponse<IncomingMessage> | Socket,
        ) => void,
    ): void;
    web(
        req: IncomingMessage,
        res: ServerResponse<IncomingMessage>,
        options: GateProxyOptions,
    ): void;
    ws(req: IncomingMessage, socket: Socket, head: Buffer, options: GateProxyOptions): void;
}

function createDefaultProxyServer(proxyTimeout: number): GateProxyServer {
    type ProxyErrorListener = (
        error: Error,
        req: IncomingMessage,
        response: IncomingMessage | ServerResponse<IncomingMessage> | Socket,
    ) => void;

    const proxyHopByHopHeaderNames = new Set([
        'connection',
        'keep-alive',
        'proxy-authenticate',
        'proxy-authorization',
        'te',
        'trailers',
        'transfer-encoding',
        'upgrade',
    ]);
    const enforcedProxyResponseHeaderNames = new Set([
        'permissions-policy',
        'referrer-policy',
        'server',
        'strict-transport-security',
        'x-content-type-options',
        'x-frame-options',
    ]);
    let errorListener: ProxyErrorListener | undefined;

    function normalizeProxyTarget(target: string): URL {
        const parsedTarget = new URL(target);
        if (parsedTarget.protocol === 'ws:') {
            parsedTarget.protocol = 'http:';
        } else if (parsedTarget.protocol === 'wss:') {
            parsedTarget.protocol = 'https:';
        }

        return parsedTarget;
    }

    function getRequestModule(targetUrl: URL): typeof createHttpRequest {
        return targetUrl.protocol === 'https:' ? createHttpsRequest : createHttpRequest;
    }

    function appendHeaderValue(existing: string | undefined, value: string): string {
        return typeof existing === 'string' && existing.length > 0
            ? `${existing}, ${value}`
            : value;
    }

    function getRequestHostHeader(req: IncomingMessage, targetUrl: URL): string {
        const hostHeader = readString(req.headers.host);
        return typeof hostHeader === 'string' ? hostHeader : targetUrl.host;
    }

    function getForwardedPort(req: IncomingMessage, targetUrl: URL): string {
        const hostHeader = getRequestHostHeader(req, targetUrl);
        const hostPort = hostHeader.lastIndexOf(':');
        if (hostPort > -1 && hostHeader.indexOf(']') < hostPort) {
            return hostHeader.slice(hostPort + 1);
        }

        if (targetUrl.port.length > 0) {
            return targetUrl.port;
        }

        return targetUrl.protocol === 'https:' ? '443' : '80';
    }

    function applyForwardedHeaders(
        headers: OutgoingHttpHeaders,
        req: IncomingMessage,
        targetUrl: URL,
        forwardedProto: string,
    ): void {
        if (typeof req.socket.remoteAddress === 'string' && req.socket.remoteAddress.length > 0) {
            headers['x-forwarded-for'] = appendHeaderValue(
                readString(headers['x-forwarded-for']),
                req.socket.remoteAddress,
            );
        }

        headers['x-forwarded-host'] = appendHeaderValue(
            readString(headers['x-forwarded-host']),
            getRequestHostHeader(req, targetUrl),
        );
        headers['x-forwarded-port'] = appendHeaderValue(
            readString(headers['x-forwarded-port']),
            getForwardedPort(req, targetUrl),
        );
        headers['x-forwarded-proto'] = appendHeaderValue(
            readString(headers['x-forwarded-proto']),
            forwardedProto,
        );
    }

    function buildProxyRequestHeaders(
        req: IncomingMessage,
        options: GateProxyOptions,
        forwardedProto: string,
    ): OutgoingHttpHeaders {
        const targetUrl = normalizeProxyTarget(options.target);
        const headers: OutgoingHttpHeaders = { ...req.headers };

        for (const [name, value] of Object.entries(options.headers)) {
            headers[name] = value;
        }

        if (options.changeOrigin) {
            headers.host = targetUrl.host;
        }

        if (options.xfwd) {
            applyForwardedHeaders(headers, req, targetUrl, forwardedProto);
        }

        return headers;
    }

    function readSetCookieName(setCookieHeader: string): string | undefined {
        const equalsIndex = setCookieHeader.indexOf('=');
        if (equalsIndex === -1) {
            return undefined;
        }

        const cookieName = setCookieHeader.slice(0, equalsIndex).trim();
        return cookieName.length > 0 ? cookieName : undefined;
    }

    function filterSetCookieHeader(
        value: string | string[],
        blockedCookieNames: ReadonlySet<string>,
    ): string | string[] | undefined {
        const values = Array.isArray(value) ? value : [value];
        const filteredValues = values.filter((entry) => {
            const cookieName = readSetCookieName(entry);
            return typeof cookieName === 'undefined' || !blockedCookieNames.has(cookieName);
        });

        if (filteredValues.length === 0) {
            return undefined;
        }

        return Array.isArray(value) ? filteredValues : filteredValues[0];
    }

    function copyProxyResponseHeaders(
        headers: IncomingHttpHeaders,
        blockedResponseCookieNames: readonly string[],
    ): OutgoingHttpHeaders {
        const responseHeaders: OutgoingHttpHeaders = {};
        const blockedCookieNames = new Set(blockedResponseCookieNames);
        for (const [name, value] of Object.entries(headers)) {
            const lowerCaseName = name.toLowerCase();
            if (
                typeof value === 'undefined' ||
                proxyHopByHopHeaderNames.has(lowerCaseName) ||
                enforcedProxyResponseHeaderNames.has(lowerCaseName)
            ) {
                continue;
            }

            if (lowerCaseName === 'set-cookie') {
                const setCookieValue = filterSetCookieHeader(value, blockedCookieNames);
                if (typeof setCookieValue === 'undefined') {
                    continue;
                }

                responseHeaders[name] = setCookieValue;
                continue;
            }

            responseHeaders[name] = value;
        }

        return responseHeaders;
    }

    function emitProxyError(
        error: Error,
        req: IncomingMessage,
        response: IncomingMessage | ServerResponse<IncomingMessage> | Socket,
    ): void {
        if (typeof errorListener === 'function') {
            errorListener(error, req, response);
        }
    }

    function createProxyRequest(
        req: IncomingMessage,
        options: GateProxyOptions,
        forwardedProto: string,
        response?: ServerResponse<IncomingMessage> | Socket,
        socket?: Socket,
        onUpgrade?: (
            upstreamResponse: IncomingMessage,
            upstreamSocket: Socket,
            upstreamHead: Buffer,
        ) => void,
    ): void {
        const targetUrl = normalizeProxyTarget(options.target);
        const requestModule = getRequestModule(targetUrl);
        const proxyRequest = requestModule(
            {
                protocol: targetUrl.protocol,
                hostname: targetUrl.hostname,
                port: targetUrl.port,
                method: req.method,
                path: req.url ?? '/',
                headers: buildProxyRequestHeaders(req, options, forwardedProto),
            },
            (upstreamResponse) => {
                if (!(response instanceof ServerResponse)) {
                    upstreamResponse.resume();
                    const failureResponse =
                        response ?? (typeof socket === 'undefined' ? new Socket() : socket);
                    emitProxyError(
                        new Error(
                            `Unexpected proxy response status ${upstreamResponse.statusCode ?? 502}.`,
                        ),
                        req,
                        failureResponse,
                    );
                    return;
                }

                response.writeHead(
                    upstreamResponse.statusCode ?? 502,
                    copyProxyResponseHeaders(
                        upstreamResponse.headers,
                        options.blockedResponseCookieNames,
                    ),
                );
                upstreamResponse.pipe(response);
            },
        );

        proxyRequest.setTimeout(proxyTimeout, () => {
            proxyRequest.destroy(new Error('Proxy request timed out.'));
        });

        proxyRequest.on('upgrade', (upstreamResponse, upstreamSocket, upstreamHead) => {
            if (typeof onUpgrade !== 'function') {
                upstreamSocket.destroy();
                const failureResponse =
                    response ?? (typeof socket === 'undefined' ? new Socket() : socket);
                emitProxyError(
                    new Error(
                        `Unexpected proxy upgrade response status ${upstreamResponse.statusCode ?? 502}.`,
                    ),
                    req,
                    failureResponse,
                );
                return;
            }

            onUpgrade(upstreamResponse, upstreamSocket, upstreamHead);
        });

        proxyRequest.on('error', (error) => {
            if (typeof response === 'undefined') {
                emitProxyError(error, req, typeof socket === 'undefined' ? new Socket() : socket);
                return;
            }

            emitProxyError(error, req, response);
        });

        req.pipe(proxyRequest);
    }

    return {
        close(): void {
            // No persistent sockets are held by the lightweight proxy.
        },
        on(event, listener): void {
            if (event === 'error') {
                errorListener = listener;
            }
        },
        web(req, res, options): void {
            createProxyRequest(req, options, options.forwardedProto, res);
        },
        ws(req, socket, head, options): void {
            createProxyRequest(
                req,
                options,
                options.forwardedProto,
                socket,
                socket,
                (upstreamResponse, upstreamSocket, upstreamHead) => {
                    const statusCode = upstreamResponse.statusCode ?? 101;
                    const statusMessage = upstreamResponse.statusMessage ?? 'Switching Protocols';
                    socket.write(`HTTP/1.1 ${statusCode} ${statusMessage}\r\n`);
                    for (const [name, value] of Object.entries(
                        copyProxyResponseHeaders(
                            upstreamResponse.headers,
                            options.blockedResponseCookieNames,
                        ),
                    )) {
                        if (Array.isArray(value)) {
                            for (const entry of value) {
                                socket.write(`${name}: ${entry}\r\n`);
                            }
                            continue;
                        }

                        socket.write(`${name}: ${value}\r\n`);
                    }
                    socket.write('\r\n');
                    if (upstreamHead.length > 0) {
                        socket.write(upstreamHead);
                    }
                    if (head.length > 0) {
                        upstreamSocket.write(head);
                    }
                    upstreamSocket.pipe(socket);
                    socket.pipe(upstreamSocket);
                    socket.on('error', () => upstreamSocket.destroy());
                    upstreamSocket.on('error', () => socket.destroy());
                },
            );
        },
    };
}

const sharedStylesPath = fileURLToPath(import.meta.resolve('magic-sso-example-ui/styles.css'));
const sharedSigninBadgeFilePath = fileURLToPath(signinBadgeUrl);
const sharedProtectedBadgeFilePath = fileURLToPath(protectedBadgeUrl);
const verifyEmailPreviewSecretHeaderName = 'x-magic-sso-preview-secret';

function readString(value: unknown): string | undefined {
    return typeof value === 'string' && value.length > 0 ? value : undefined;
}

function buildGateContentSecurityPolicy(): string {
    return [
        "default-src 'self'",
        "base-uri 'none'",
        "form-action 'self'",
        "frame-ancestors 'none'",
        "img-src 'self' data:",
        "object-src 'none'",
        "style-src 'self'",
    ].join('; ');
}

const permissionsPolicyValue = 'camera=(), geolocation=(), microphone=(), payment=(), usb=()';
const strictTransportSecurityValue = 'max-age=15552000; includeSubDomains';

function isHtmlResponse(reply: FastifyReply): boolean {
    const contentType = reply.getHeader('content-type');
    return typeof contentType === 'string' && contentType.includes('text/html');
}

function applyDefaultSecurityHeaders(request: FastifyRequest, reply: FastifyReply): void {
    reply.removeHeader('Server');
    if (isHtmlResponse(reply)) {
        setNoStoreHeaders(reply);
    }

    reply.header('Content-Security-Policy', buildGateContentSecurityPolicy());
    reply.header('Permissions-Policy', permissionsPolicyValue);
    if (typeof reply.getHeader('Referrer-Policy') === 'undefined') {
        reply.header('Referrer-Policy', 'same-origin');
    }
    reply.header('X-Content-Type-Options', 'nosniff');
    reply.header('X-Frame-Options', 'DENY');

    if (request.protocol === 'https') {
        reply.header('Strict-Transport-Security', strictTransportSecurityValue);
    }
}

function setNoStoreHeaders(reply: FastifyReply): void {
    reply.header('Cache-Control', 'no-store');
    reply.header('Pragma', 'no-cache');
}

function sendInternalServerError(reply: FastifyReply, request: FastifyRequest): void {
    setNoStoreHeaders(reply);
    reply.code(500);

    if (isJsonLikeRequest(request)) {
        reply.send({ message: 'Internal Server Error' });
        return;
    }

    reply.type('text/html; charset=utf-8');
    reply.send(`<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>Internal Server Error | Magic Link SSO Gate</title>
  </head>
  <body>
    <main>
      <h1>Internal Server Error</h1>
      <p>Something went wrong.</p>
    </main>
  </body>
</html>`);
}

function applyProxiedResponseSecurityHeaders(
    isHttpsRequest: boolean,
    response: ServerResponse<IncomingMessage>,
): void {
    response.removeHeader('Server');
    response.setHeader('Permissions-Policy', permissionsPolicyValue);
    response.setHeader('Referrer-Policy', 'same-origin');
    response.setHeader('X-Content-Type-Options', 'nosniff');
    response.setHeader('X-Frame-Options', 'DENY');

    if (isHttpsRequest) {
        response.setHeader('Strict-Transport-Security', strictTransportSecurityValue);
    }
}

function isVerifyEmailResponse(value: unknown): value is VerifyEmailResponse {
    return (
        typeof value === 'object' &&
        value !== null &&
        'accessToken' in value &&
        typeof value.accessToken === 'string' &&
        value.accessToken.length > 0
    );
}

function isVerifyEmailPreviewResponse(value: unknown): value is VerifyEmailPreviewResponse {
    return (
        typeof value === 'object' &&
        value !== null &&
        'email' in value &&
        typeof value.email === 'string' &&
        value.email.length > 0
    );
}

function isSignInSuccessResponse(value: unknown): value is SignInSuccessResponse {
    return (
        typeof value === 'object' &&
        value !== null &&
        'message' in value &&
        typeof value.message === 'string' &&
        value.message === 'Verification email sent'
    );
}

function createVerifyCsrfToken(secret: Buffer): string {
    const nonce = randomBytes(32).toString('base64url');
    const signature = createHmac('sha256', secret).update(nonce).digest('base64url');
    return `${nonce}.${signature}`;
}

function isValidVerifyCsrfToken(token: string, secret: Buffer): boolean {
    const [nonce, signature, ...rest] = token.split('.');
    if (
        typeof nonce !== 'string' ||
        nonce.length === 0 ||
        typeof signature !== 'string' ||
        signature.length === 0 ||
        rest.length > 0
    ) {
        return false;
    }

    const expectedSignature = createHmac('sha256', secret).update(nonce).digest('base64url');
    return safeCompare(signature, expectedSignature);
}

function safeCompare(left: string, right: string): boolean {
    const leftBuffer = Buffer.from(left);
    const rightBuffer = Buffer.from(right);
    if (leftBuffer.length !== rightBuffer.length) {
        return false;
    }

    return timingSafeEqual(leftBuffer, rightBuffer);
}

function readServerUrlConfigError(serverUrl: string, publicOrigin: string): string | null {
    try {
        const parsedServerUrl = new URL(serverUrl);
        if (parsedServerUrl.origin === publicOrigin) {
            return 'auth.serverUrl points to this gate. Set it to the Magic Link SSO server instead.';
        }
    } catch {
        return 'auth.serverUrl must be an absolute URL.';
    }

    return null;
}

function hasSameOriginMutationSource(request: FastifyRequest, config: GateConfig): boolean {
    const fetchSiteHeader = readString(request.headers['sec-fetch-site']);
    if (fetchSiteHeader === 'same-origin') {
        return true;
    }

    const originHeader = readString(request.headers.origin);
    if (typeof originHeader === 'string') {
        return originHeader === config.publicOrigin;
    }

    const refererHeader = readString(request.headers.referer);
    if (typeof refererHeader !== 'string') {
        return false;
    }

    try {
        return new URL(refererHeader).origin === config.publicOrigin;
    } catch {
        return false;
    }
}

function buildLoginRedirectUrl(
    config: GateConfig,
    returnUrl: string,
    options: { error?: string; result?: string } = {},
): string {
    const loginUrl = new URL(buildPublicUrl(config, buildGatePath(config, '/login')));
    loginUrl.searchParams.set('returnUrl', returnUrl);

    if (typeof options.error === 'string') {
        loginUrl.searchParams.set('error', options.error);
    }
    if (typeof options.result === 'string') {
        loginUrl.searchParams.set('result', options.result);
    }

    return `${loginUrl.pathname}${loginUrl.search}`;
}

function buildStylesRoute(config: GateConfig): string {
    return buildGatePath(config, '/assets/styles.css');
}

function buildSigninBadgeRoute(config: GateConfig): string {
    return buildGatePath(config, '/assets/signin-page-badge.svg');
}

function buildProtectedBadgeRoute(config: GateConfig): string {
    return buildGatePath(config, '/assets/protected-page-badge.svg');
}

function buildVerifyEmailScriptRoute(config: GateConfig): string {
    return buildGatePath(config, '/assets/verify-email-page.js');
}

function buildVerifyCsrfCookieName(config: GateConfig): string {
    return `${config.cookieName}.verify-csrf`;
}

function buildVerifyTokenCookieName(config: GateConfig): string {
    return `${config.cookieName}.verify-token`;
}

function buildBlockedResponseCookieNames(config: GateConfig): string[] {
    return [
        config.cookieName,
        buildVerifyCsrfCookieName(config),
        buildVerifyTokenCookieName(config),
    ];
}

function buildVerifyCsrfCookieOptions(config: GateConfig): {
    httpOnly: true;
    path: string;
    sameSite: 'strict';
    secure: boolean;
} {
    return {
        httpOnly: true,
        path: buildGatePath(config, '/verify-email'),
        sameSite: 'strict',
        secure: config.publicOrigin.startsWith('https://'),
    };
}

function buildVerifyTokenCookieOptions(config: GateConfig): {
    httpOnly: true;
    path: string;
    sameSite: 'strict';
    secure: boolean;
} {
    return {
        httpOnly: true,
        path: buildGatePath(config, '/verify-email'),
        sameSite: 'strict',
        secure: config.publicOrigin.startsWith('https://'),
    };
}

async function readResponsePayload(response: Response): Promise<unknown> {
    return response.json().catch(async () => ({
        message: await response.text().catch(() => ''),
    }));
}

async function revokeGateSessionOnServer(token: string, config: GateConfig): Promise<void> {
    const response = await fetch(new URL('/logout', config.serverUrl), {
        method: 'POST',
        headers: {
            accept: 'application/json',
            authorization: `Bearer ${token}`,
        },
        cache: 'no-store',
        redirect: 'error',
        signal: AbortSignal.timeout(config.requestTimeoutMs),
    });

    if (!response.ok) {
        throw new Error(`Magic Link SSO server logout failed with status ${response.status}.`);
    }
}

async function serveFile(
    reply: FastifyReply,
    filePath: string,
    contentType: string,
): Promise<FastifyReply> {
    const fileContents = await readFile(filePath);
    reply.type(contentType);
    return reply.send(fileContents);
}

function isJsonLikeRequest(request: FastifyRequest): boolean {
    const acceptHeader = readString(request.headers.accept);
    if (typeof acceptHeader === 'string' && acceptHeader.includes('application/json')) {
        return true;
    }

    const requestedWith = readString(request.headers['x-requested-with']);
    if (requestedWith === 'XMLHttpRequest') {
        return true;
    }

    const fetchDest = readString(request.headers['sec-fetch-dest']);
    return typeof fetchDest === 'string' && fetchDest !== 'document' && fetchDest !== 'empty';
}

function readSocketPeerAddress(message: IncomingMessage): string {
    // Rate limiting must rely on the actual socket peer address so spoofed
    // forwarded headers cannot change the client identity.
    return message.socket.remoteAddress ?? 'unknown';
}

function sendTooManyRequestsResponse(reply: FastifyReply, retryAfterSeconds: number): void {
    setNoStoreHeaders(reply);
    reply.header('Retry-After', retryAfterSeconds.toString());
    reply.code(429).send({ message: 'Too many requests.' });
}

function writeTooManyRequestsResponse(socket: Socket, retryAfterSeconds: number): void {
    socket.write(
        [
            'HTTP/1.1 429 Too Many Requests',
            'Connection: close',
            'Cache-Control: no-store',
            'Content-Type: application/json; charset=utf-8',
            'Pragma: no-cache',
            `Retry-After: ${retryAfterSeconds}`,
            '',
            JSON.stringify({ message: 'Too many requests.' }),
        ].join('\r\n'),
    );
    socket.destroy();
}

function buildProxyPath(requestUrl: string | undefined, config: GateConfig): string | null {
    const parsedUrl = new URL(requestUrl ?? '/', config.publicOrigin);
    const strippedPathname = stripPublicPathPrefix(parsedUrl.pathname, config);
    if (strippedPathname === null) {
        return null;
    }

    const upstreamPath =
        config.upstreamBasePath.length === 0
            ? strippedPathname
            : strippedPathname === '/'
              ? `${config.upstreamBasePath}/`
              : `${config.upstreamBasePath}${strippedPathname}`;
    return `${upstreamPath}${parsedUrl.search}`;
}

function writeProxyErrorResponse(
    response: IncomingMessage | ServerResponse<IncomingMessage> | Socket,
): void {
    if (response instanceof IncomingMessage) {
        return;
    }

    if (!(response instanceof Socket)) {
        if (!response.headersSent) {
            response.writeHead(502, {
                'content-type': 'application/json; charset=utf-8',
            });
            response.end(
                JSON.stringify({ message: 'The gate could not reach the protected upstream.' }),
            );
        }
        return;
    }

    response.write('HTTP/1.1 502 Bad Gateway\r\nConnection: close\r\n\r\n');
    response.destroy();
}

function clearVerifyEmailCookies(reply: FastifyReply, config: GateConfig): void {
    reply.clearCookie(buildVerifyCsrfCookieName(config), buildVerifyCsrfCookieOptions(config));
    reply.clearCookie(buildVerifyTokenCookieName(config), buildVerifyTokenCookieOptions(config));
}

function buildUpstreamHeaders(auth: AuthPayload): Record<string, string> {
    return {
        'x-magic-sso-site-id': auth.siteId,
        'x-magic-sso-user-email': auth.email,
        'x-magic-sso-user-scope': auth.scope,
    };
}

function stripCookieFromHeader(
    cookieHeader: string | undefined,
    cookieName: string,
): string | undefined {
    if (typeof cookieHeader !== 'string' || cookieHeader.length === 0) {
        return undefined;
    }

    const remainingCookies = cookieHeader
        .split(';')
        .map((cookie) => cookie.trim())
        .filter((cookie) => {
            const equalsIndex = cookie.indexOf('=');
            if (equalsIndex === -1) {
                return true;
            }

            return cookie.slice(0, equalsIndex).trim() !== cookieName;
        });

    return remainingCookies.length === 0 ? undefined : remainingCookies.join('; ');
}

function stripGateAuthCookie(req: IncomingMessage, cookieName: string): void {
    const strippedCookieHeader = stripCookieFromHeader(req.headers.cookie, cookieName);
    if (typeof strippedCookieHeader === 'undefined') {
        delete req.headers.cookie;
        return;
    }

    req.headers.cookie = strippedCookieHeader;
}

const spoofableProxyHeaderNames = new Set([
    'forwarded',
    'x-forwarded-for',
    'x-forwarded-host',
    'x-forwarded-port',
    'x-forwarded-prefix',
    'x-forwarded-proto',
    'x-real-ip',
]);

function stripTrustedUpstreamHeaders(req: IncomingMessage): void {
    for (const key of Object.keys(req.headers)) {
        const lowerCaseKey = key.toLowerCase();
        if (
            lowerCaseKey.startsWith('x-magic-sso-') ||
            spoofableProxyHeaderNames.has(lowerCaseKey)
        ) {
            delete req.headers[key];
        }
    }
}

function decorateProxyRequest(req: IncomingMessage, upstreamUrl: string): void {
    req.url = upstreamUrl;
}

function hasExpectedWebSocketOrigin(req: IncomingMessage, config: GateConfig): boolean {
    const originHeader = readString(req.headers.origin);
    return originHeader === config.publicOrigin;
}

async function handleProxyRequest(
    request: FastifyRequest,
    reply: FastifyReply,
    config: GateConfig,
    proxy: GateProxyServer,
): Promise<void> {
    const auth = await verifyRequestAuth(request.headers.cookie, config);
    if (auth === null) {
        if (isJsonLikeRequest(request)) {
            reply.code(401).send({ message: 'Authentication required.' });
            return;
        }

        const returnUrl = normaliseReturnUrl(
            new URL(request.raw.url ?? '/', config.publicOrigin).toString(),
            config,
        );
        return reply.redirect(buildLoginTarget(config, returnUrl));
    }

    const upstreamUrl = buildProxyPath(request.raw.url, config);
    if (upstreamUrl === null) {
        reply.code(404).send({ message: 'Not found.' });
        return;
    }

    const isHttpsRequest = request.protocol === 'https';
    decorateProxyRequest(request.raw, upstreamUrl);
    stripTrustedUpstreamHeaders(request.raw);
    stripGateAuthCookie(request.raw, config.cookieName);
    reply.hijack();
    applyProxiedResponseSecurityHeaders(isHttpsRequest, reply.raw);
    proxy.web(request.raw, reply.raw, {
        blockedResponseCookieNames: buildBlockedResponseCookieNames(config),
        changeOrigin: true,
        forwardedProto: request.protocol,
        headers: buildUpstreamHeaders(auth),
        target: config.upstreamUrl,
        xfwd: true,
    });
}

function buildLoginMessage(query: LoginQuery): LoginPageMessage | undefined {
    const errorMessage = getLoginErrorMessage(readString(query.error));

    if (typeof errorMessage === 'string') {
        return {
            kind: 'error',
            text: errorMessage,
        };
    }

    const result = readString(query.result);
    switch (result) {
        case 'signin-email-sent':
            return {
                kind: 'success',
                text: 'Verification email sent.',
            };
        case 'signin-failed':
            return {
                kind: 'error',
                text: 'Failed to send verification email.',
            };
        case 'signin-forbidden':
            return {
                kind: 'error',
                text: 'Forbidden.',
            };
        case 'signin-invalid-request':
            return {
                kind: 'error',
                text: 'Invalid sign-in request.',
            };
        case 'signin-service-unavailable':
            return {
                kind: 'error',
                text: 'The authentication service is temporarily unavailable.',
            };
    }

    return undefined;
}

function resolvePageTitle(config: GateConfig): string {
    return config.mode === 'subdomain'
        ? 'Sign In | Magic Link SSO Gate'
        : 'Sign In | Magic Link SSO Gate (Path Prefix)';
}

export async function createApp(options: CreateAppOptions = {}): Promise<FastifyInstance> {
    const config =
        typeof options.config === 'undefined' ? loadConfig() : resolveGateConfig(options.config);
    const rateLimiter = await createGateRateLimiter({
        keyPrefix: config.rateLimitKeyPrefix,
        max: config.rateLimitMax,
        redisUrl: config.rateLimitRedisUrl,
        windowMs: config.rateLimitWindowMs,
    });
    const proxy = options.proxyFactory?.() ?? createDefaultProxyServer(config.requestTimeoutMs);

    const app = Fastify({
        logger:
            typeof options.logger === 'undefined'
                ? {
                      level: 'info',
                  }
                : options.logger,
        trustProxy: config.trustProxy,
    });

    for (const warning of collectGateTargetWarnings(config)) {
        app.log.warn(
            warning,
            'Gate target uses a private, loopback, link-local, or metadata-adjacent host. Confirm this is intentional.',
        );
    }

    proxy.on('error', (error, _req, response) => {
        app.log.error({ err: error }, 'Proxy error');
        writeProxyErrorResponse(response);
    });

    await app.register(cookie);
    await app.register(formbody);

    app.setErrorHandler((error, request, reply): void => {
        request.log.error({ err: error }, 'Unhandled gate error');
        if (reply.sent) {
            return;
        }

        sendInternalServerError(reply, request);
    });

    app.addHook('onRequest', async (request, reply): Promise<void> => {
        const decision = await rateLimiter.consume(readSocketPeerAddress(request.raw));
        if (!decision.allowed && typeof decision.retryAfterSeconds === 'number') {
            sendTooManyRequestsResponse(reply, decision.retryAfterSeconds);
            return;
        }
    });

    app.addHook('onSend', async (request, reply, payload): Promise<unknown> => {
        applyDefaultSecurityHeaders(request, reply);
        return payload;
    });

    app.addHook('onClose', async (): Promise<void> => {
        proxy.close();
        await rateLimiter.close();
    });

    app.server.on('upgrade', async (req, socket: Socket, head) => {
        const decision = await rateLimiter.consume(readSocketPeerAddress(req));
        if (!decision.allowed && typeof decision.retryAfterSeconds === 'number') {
            writeTooManyRequestsResponse(socket, decision.retryAfterSeconds);
            return;
        }

        const parsedUrl = new URL(req.url ?? '/', config.publicOrigin);
        if (isNamespacePath(parsedUrl.pathname, config) || !config.wsEnabled) {
            socket.write('HTTP/1.1 404 Not Found\r\nConnection: close\r\n\r\n');
            socket.destroy();
            return;
        }

        const upstreamUrl = buildProxyPath(req.url, config);
        if (upstreamUrl === null) {
            socket.write('HTTP/1.1 404 Not Found\r\nConnection: close\r\n\r\n');
            socket.destroy();
            return;
        }

        if (!hasExpectedWebSocketOrigin(req, config)) {
            socket.write('HTTP/1.1 403 Forbidden\r\nConnection: close\r\n\r\n');
            socket.destroy();
            return;
        }

        const auth = await verifyRequestAuth(readString(req.headers.cookie), config);
        if (auth === null) {
            socket.write('HTTP/1.1 401 Unauthorized\r\nConnection: close\r\n\r\n');
            socket.destroy();
            return;
        }

        decorateProxyRequest(req, upstreamUrl);
        stripTrustedUpstreamHeaders(req);
        stripGateAuthCookie(req, config.cookieName);
        proxy.ws(req, socket, head, {
            blockedResponseCookieNames: buildBlockedResponseCookieNames(config),
            changeOrigin: true,
            forwardedProto: readString(req.headers['x-forwarded-proto']) ?? 'http',
            headers: buildUpstreamHeaders(auth),
            target: config.upstreamUrl,
            xfwd: true,
        });
    });

    app.get(buildStylesRoute(config), async (_request, reply) =>
        serveFile(reply, sharedStylesPath, 'text/css; charset=utf-8'),
    );
    app.get(buildSigninBadgeRoute(config), async (_request, reply) =>
        serveFile(reply, sharedSigninBadgeFilePath, 'image/svg+xml; charset=utf-8'),
    );
    app.get(buildProtectedBadgeRoute(config), async (_request, reply) =>
        serveFile(reply, sharedProtectedBadgeFilePath, 'image/svg+xml; charset=utf-8'),
    );
    app.get(buildVerifyEmailScriptRoute(config), async (_request, reply) => {
        reply.type('text/javascript; charset=utf-8');
        return reply.send(verifyEmailPageScript);
    });

    app.get(buildGatePath(config, '/healthz'), async () => ({ ok: true }));

    app.get<{ Querystring: LoginQuery }>(
        buildGatePath(config, '/login'),
        async (request, reply) => {
            const returnUrl = normaliseReturnUrl(readString(request.query.returnUrl), config);
            reply.type('text/html; charset=utf-8');
            return reply.send(
                renderLoginPage({
                    backUrl:
                        config.protectedRootPath === '/' ? '/' : `${config.protectedRootPath}/`,
                    loginAction: buildGatePath(config, '/signin'),
                    message: buildLoginMessage(request.query),
                    returnUrl,
                    signinBadgePath: buildSigninBadgeRoute(config),
                    stylesPath: buildStylesRoute(config),
                    title: resolvePageTitle(config),
                }),
            );
        },
    );

    app.post<{ Body: SignInBody }>(buildGatePath(config, '/signin'), async (request, reply) => {
        if (!hasSameOriginMutationSource(request, config)) {
            reply.code(403).send({ message: 'Forbidden' });
            return;
        }

        const email = readString(request.body.email);
        const returnUrl = normaliseReturnUrl(readString(request.body.returnUrl), config);
        const verifyUrl = buildVerifyUrl(config, returnUrl);

        if (typeof email !== 'string' || verifyUrl.length === 0) {
            return reply.redirect(
                buildLoginRedirectUrl(config, returnUrl, {
                    result: 'signin-invalid-request',
                }),
            );
        }

        const serverUrlConfigError = readServerUrlConfigError(
            config.serverUrl,
            config.publicOrigin,
        );
        if (typeof serverUrlConfigError === 'string') {
            return reply.redirect(
                buildLoginRedirectUrl(config, returnUrl, {
                    result: 'signin-service-unavailable',
                }),
            );
        }

        try {
            const ssoResponse = await fetch(new URL('/signin', config.serverUrl), {
                method: 'POST',
                headers: {
                    accept: 'application/json',
                    'content-type': 'application/json',
                },
                body: JSON.stringify({
                    email,
                    returnUrl,
                    verifyUrl,
                }),
                cache: 'no-store',
                redirect: 'error',
            });

            if (!ssoResponse.ok) {
                await readResponsePayload(ssoResponse);
                return reply.redirect(
                    buildLoginRedirectUrl(config, returnUrl, {
                        result: ssoResponse.status === 403 ? 'signin-forbidden' : 'signin-failed',
                    }),
                );
            }

            const payload = await readResponsePayload(ssoResponse);
            if (!isSignInSuccessResponse(payload)) {
                return reply.redirect(
                    buildLoginRedirectUrl(config, returnUrl, {
                        result: 'signin-service-unavailable',
                    }),
                );
            }

            return reply.redirect(
                buildLoginRedirectUrl(config, returnUrl, {
                    result: 'signin-email-sent',
                }),
            );
        } catch (error: unknown) {
            void error;
            return reply.redirect(
                buildLoginRedirectUrl(config, returnUrl, {
                    result: 'signin-failed',
                }),
            );
        }
    });

    app.get<{ Querystring: VerifyEmailQuery }>(
        buildGatePath(config, '/verify-email'),
        async (request, reply) => {
            const token = readString(request.query.token);
            const returnUrl = normaliseReturnUrl(readString(request.query.returnUrl), config);
            reply.header('Referrer-Policy', 'no-referrer');

            if (typeof token !== 'string') {
                reply.clearCookie(
                    buildVerifyTokenCookieName(config),
                    buildVerifyTokenCookieOptions(config),
                );
                return reply.redirect(
                    buildLoginRedirectUrl(config, returnUrl, {
                        error: 'missing-verification-token',
                    }),
                );
            }

            try {
                const verifyUrl = new URL('/verify-email', config.serverUrl);
                verifyUrl.searchParams.set('token', token);

                const previewResponse = await fetch(verifyUrl, {
                    headers: {
                        accept: 'application/json',
                        [verifyEmailPreviewSecretHeaderName]: config.previewSecret,
                    },
                    cache: 'no-store',
                    redirect: 'error',
                });

                if (!previewResponse.ok) {
                    reply.clearCookie(
                        buildVerifyTokenCookieName(config),
                        buildVerifyTokenCookieOptions(config),
                    );
                    return reply.redirect(
                        buildLoginRedirectUrl(config, returnUrl, {
                            error: 'verify-email-failed',
                        }),
                    );
                }

                const payload: unknown = await previewResponse.json();
                if (!isVerifyEmailPreviewResponse(payload)) {
                    reply.clearCookie(
                        buildVerifyTokenCookieName(config),
                        buildVerifyTokenCookieOptions(config),
                    );
                    return reply.redirect(
                        buildLoginRedirectUrl(config, returnUrl, {
                            error: 'verify-email-failed',
                        }),
                    );
                }

                const csrfToken = createVerifyCsrfToken(deriveVerifyCsrfSecret(config.jwtSecret));
                reply.setCookie(
                    buildVerifyCsrfCookieName(config),
                    csrfToken,
                    buildVerifyCsrfCookieOptions(config),
                );
                reply.setCookie(
                    buildVerifyTokenCookieName(config),
                    token,
                    buildVerifyTokenCookieOptions(config),
                );
                reply.type('text/html; charset=utf-8');
                return reply.send(
                    renderVerifyEmailConfirmationPage({
                        csrfToken,
                        email: payload.email,
                        returnUrl,
                        scriptPath: buildVerifyEmailScriptRoute(config),
                        signinBadgePath: buildSigninBadgeRoute(config),
                        stylesPath: buildStylesRoute(config),
                        submitAction: buildGatePath(config, '/verify-email'),
                    }),
                );
            } catch {
                reply.clearCookie(
                    buildVerifyTokenCookieName(config),
                    buildVerifyTokenCookieOptions(config),
                );
                return reply.redirect(
                    buildLoginRedirectUrl(config, returnUrl, {
                        error: 'verify-email-failed',
                    }),
                );
            }
        },
    );

    app.post<{ Body: VerifyEmailBody }>(
        buildGatePath(config, '/verify-email'),
        async (request, reply) => {
            if (!hasSameOriginMutationSource(request, config)) {
                reply.code(403).send({ message: 'Forbidden' });
                return;
            }

            const submittedToken = readString(request.body.token);
            const cookieToken = readCookieValue(
                request.headers.cookie,
                buildVerifyTokenCookieName(config),
            );
            const submittedCsrfToken = readString(request.body.csrfToken);
            const returnUrl = normaliseReturnUrl(readString(request.body.returnUrl), config);
            const cookieCsrfToken = readCookieValue(
                request.headers.cookie,
                buildVerifyCsrfCookieName(config),
            );
            const token =
                typeof submittedToken === 'string'
                    ? typeof cookieToken === 'string' && submittedToken !== cookieToken
                        ? undefined
                        : submittedToken
                    : cookieToken;

            if (
                typeof token !== 'string' ||
                typeof submittedCsrfToken !== 'string' ||
                typeof cookieCsrfToken !== 'string' ||
                !safeCompare(submittedCsrfToken, cookieCsrfToken) ||
                !isValidVerifyCsrfToken(
                    submittedCsrfToken,
                    deriveVerifyCsrfSecret(config.jwtSecret),
                )
            ) {
                clearVerifyEmailCookies(reply, config);
                return reply.redirect(
                    buildLoginRedirectUrl(config, returnUrl, {
                        error: 'verify-email-failed',
                    }),
                );
            }

            try {
                const verifyResponse = await fetch(new URL('/verify-email', config.serverUrl), {
                    method: 'POST',
                    headers: {
                        accept: 'application/json',
                        'content-type': 'application/json',
                    },
                    body: JSON.stringify({ token }),
                    cache: 'no-store',
                    redirect: 'error',
                });

                if (!verifyResponse.ok) {
                    clearVerifyEmailCookies(reply, config);
                    return reply.redirect(
                        buildLoginRedirectUrl(config, returnUrl, {
                            error: 'verify-email-failed',
                        }),
                    );
                }

                const payload: unknown = await verifyResponse.json();
                if (!isVerifyEmailResponse(payload)) {
                    clearVerifyEmailCookies(reply, config);
                    return reply.redirect(
                        buildLoginRedirectUrl(config, returnUrl, {
                            error: 'verify-email-failed',
                        }),
                    );
                }

                const jwtSecret = getJwtSecret(config);
                if (jwtSecret === null) {
                    clearVerifyEmailCookies(reply, config);
                    return reply.redirect(
                        buildLoginRedirectUrl(config, returnUrl, {
                            error: 'session-verification-misconfigured',
                        }),
                    );
                }

                const auth = await verifyAuthToken(payload.accessToken, jwtSecret, {
                    expectedAudience: config.publicOrigin,
                    expectedIssuer: config.serverUrl,
                });
                if (auth === null) {
                    clearVerifyEmailCookies(reply, config);
                    return reply.redirect(
                        buildLoginRedirectUrl(config, returnUrl, {
                            error: 'session-verification-failed',
                        }),
                    );
                }

                clearVerifyEmailCookies(reply, config);
                reply.setCookie(
                    config.cookieName,
                    payload.accessToken,
                    buildAuthCookieOptions(config),
                );
                return reply.redirect(returnUrl);
            } catch {
                clearVerifyEmailCookies(reply, config);
                return reply.redirect(
                    buildLoginRedirectUrl(config, returnUrl, {
                        error: 'verify-email-failed',
                    }),
                );
            }
        },
    );

    app.post(buildGatePath(config, '/logout'), async (request, reply) => {
        if (!hasSameOriginMutationSource(request, config)) {
            reply.code(403).send({ message: 'Forbidden' });
            return;
        }

        const token = readCookieValue(request.headers.cookie, config.cookieName);
        if (typeof token === 'string' && token.length > 0) {
            try {
                await revokeGateSessionOnServer(token, config);
            } catch (error) {
                request.log.warn(
                    {
                        error,
                    },
                    'Failed to revoke the current Magic Link SSO Gate session on the server',
                );
            }
        }

        reply.clearCookie(config.cookieName, buildAuthCookieOptions(config));
        return reply.redirect(
            config.protectedRootPath === '/' ? '/' : `${config.protectedRootPath}/`,
        );
    });

    app.get(buildGatePath(config, '/session'), async (request, reply) => {
        setNoStoreHeaders(reply);
        const auth = await verifyRequestAuth(request.headers.cookie, config);
        return auth === null
            ? { authenticated: false }
            : {
                  authenticated: true,
                  email: auth.email,
                  scope: auth.scope,
                  siteId: auth.siteId,
              };
    });

    const proxyHandler: RouteHandlerMethod = async (request, reply) => {
        await handleProxyRequest(request, reply, config, proxy);
    };

    app.all('/', proxyHandler);
    app.all('/*', proxyHandler);

    return app;
}
