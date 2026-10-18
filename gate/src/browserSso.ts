// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Wojciech Polak

import {
    createBrowserSsoHttpHandler,
    parseBrowserSsoCookies,
    isBrowserSsoDocumentNavigation,
    type BrowserSsoClient,
    type BrowserSsoCookie,
    type BrowserSsoClientError,
} from '@magic-link-sso/core';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { buildAuthCookieOptions, buildLegacyLoginTarget } from './auth.js';
import { buildGatePath, normaliseReturnUrl, type GateConfig } from './config.js';
import { renderBrowserSsoPage } from './html.js';

const messages: Record<BrowserSsoClientError, string> = {
    invalid_request: 'This sign-in request is invalid. Return to the application to start again.',
    invalid_transaction:
        'This sign-in does not match an open sign-in tab. Return to the application to start again.',
    transaction_expired: 'This sign-in has expired. Return to the application to start again.',
    transaction_limit:
        'Finish a sign-in in another tab, or wait for it to expire before trying again.',
    transaction_too_large:
        'This address is too long for sign-in. Return to the application and open a shorter link.',
    sso_required:
        'This application requires browser SSO. Contact its administrator to check the sign-in service.',
    temporarily_unavailable:
        'Magic Link SSO is temporarily unavailable. Return to the application to try again.',
    exchange_failed: 'Sign-in could not be completed. Return to the application to start again.',
    invalid_token: 'The application could not verify this session. Contact its administrator.',
    sso_disabled: 'Browser SSO is disabled. Return to the application to start again.',
    access_denied: 'This account does not have access to the application.',
};

function toFetchHeaders(values: FastifyRequest['headers']): Headers {
    const headers = new Headers();
    for (const [name, value] of Object.entries(values)) {
        for (const entry of [value].flat()) {
            if (entry !== undefined) {
                headers.append(name, entry);
            }
        }
    }
    return headers;
}
function toFetchForm(method: string, body: unknown): URLSearchParams {
    const form = new URLSearchParams();
    if (method === 'POST' && typeof body === 'object' && body !== null) {
        for (const [name, value] of Object.entries(body)) {
            for (const entry of [value].flat()) {
                if (typeof entry === 'string') {
                    form.append(name, entry);
                }
            }
        }
    }
    return form;
}

function applyBrowserSsoCookies(reply: FastifyReply, cookies: readonly BrowserSsoCookie[]): void {
    for (const { name, value, ...attributes } of cookies) {
        reply.setCookie(name, value, attributes);
    }
}

export async function registerGateBrowserSsoRoutes(
    app: FastifyInstance,
    config: GateConfig,
    client: BrowserSsoClient,
): Promise<void> {
    await app.register(
        async (sso): Promise<void> => {
            sso.addHook('onRequest', async (_request, reply): Promise<void> => {
                reply
                    .header('Cache-Control', 'no-store')
                    .header('Pragma', 'no-cache')
                    .header('Referrer-Policy', 'no-referrer');
            });
            const root = normaliseReturnUrl(undefined, config);
            const startPath = buildGatePath(config, '/sso/start');
            const signedOutPath = buildGatePath(config, '/signed-out');
            const stylesPath = buildGatePath(config, '/assets/styles.css');

            function documentNavigation(request: FastifyRequest, reply: FastifyReply): boolean {
                if (
                    isBrowserSsoDocumentNavigation({
                        get(name): string | null {
                            const value = request.headers[name];
                            return typeof value === 'string'
                                ? value
                                : Array.isArray(value)
                                  ? value.join(',')
                                  : null;
                        },
                    })
                ) {
                    return false;
                }
                const url = new URL(request.url, config.publicOrigin);
                url.searchParams.delete('_rsc');
                reply.type('text/html; charset=utf-8').send(
                    renderBrowserSsoPage({
                        title: 'Continue sign-in',
                        message: 'Continue in this tab to complete sign-in.',
                        stylesPath,
                        nextHref: new URL(url.pathname + url.search, config.publicOrigin).href,
                        nextText: 'Continue sign-in',
                    }),
                );
                return true;
            }

            function fail(
                reply: FastifyReply,
                error: BrowserSsoClientError,
                returnUrl = root,
            ): void {
                reply
                    .type('text/html; charset=utf-8')
                    .code(
                        error === 'access_denied'
                            ? 403
                            : error === 'transaction_limit'
                              ? 429
                              : error === 'temporarily_unavailable' ||
                                  error === 'sso_required' ||
                                  error === 'exchange_failed' ||
                                  error === 'invalid_token'
                                ? 503
                                : 400,
                    )
                    .send(
                        renderBrowserSsoPage({
                            title: 'Sign-in could not be completed',
                            message: messages[error],
                            stylesPath,
                            nextHref: normaliseReturnUrl(returnUrl, config),
                            nextText: 'Return to application',
                            isError: true,
                        }),
                    );
            }
            if (config.browserSso.mode !== 'off' && config.browserSso.loginUi === 'app-owned') {
                const handler = createBrowserSsoHttpHandler({
                    mode: config.browserSso.mode,
                    loginUi: 'app-owned',
                    issuer: config.serverUrl,
                    audience: config.publicOrigin,
                    redirectUri: new URL(
                        buildGatePath(config, '/sso/callback'),
                        config.publicOrigin,
                    ).href,
                    secret: config.jwtSecret,
                    previewSecret: config.previewSecret,
                    cookieName: config.cookieName,
                    cookiePath: config.cookiePath,
                    ...(config.cookieMaxAge === undefined
                        ? {}
                        : { cookieMaxAge: config.cookieMaxAge }),
                    allowInsecureLocalhost: config.browserSso.allowInsecureLocalhost,
                    timeoutMs: config.browserSso.requestTimeoutMs,
                    paths: {
                        start: startPath,
                        callback: buildGatePath(config, '/sso/callback'),
                        signedOut: signedOutPath,
                    },
                    legacyLoginPath: buildGatePath(config, '/signin'),
                    legacyDirectUse: config.directUse,
                });
                for (const path of [
                    startPath,
                    buildGatePath(config, '/sso/callback'),
                    signedOutPath,
                ]) {
                    sso.route({
                        method: ['GET', 'POST'],
                        url: path,
                        handler: async (request, reply): Promise<void> => {
                            const url = new URL(request.url, config.publicOrigin);
                            if (
                                url.pathname === startPath &&
                                !url.searchParams.has('ssoPrepared') &&
                                !url.searchParams.has('action')
                            ) {
                                url.searchParams.set(
                                    'returnUrl',
                                    normaliseReturnUrl(
                                        url.searchParams.get('returnUrl') ?? undefined,
                                        config,
                                    ),
                                );
                            }
                            const headers = toFetchHeaders(request.headers);
                            const form = toFetchForm(request.method, request.body);
                            const response = await handler(
                                new Request(url, {
                                    method: request.method,
                                    headers,
                                    ...(request.method === 'POST' ? { body: form.toString() } : {}),
                                }),
                            );
                            reply.code(response.status);
                            for (const [name, value] of response.headers) {
                                if (name !== 'set-cookie') {
                                    reply.header(name, value);
                                }
                            }
                            if (response.headers.getSetCookie().length) {
                                reply.header('set-cookie', response.headers.getSetCookie());
                            }
                            reply.send(await response.text());
                        },
                    });
                }
                return;
            }
            sso.get(startPath, async (request, reply): Promise<void> => {
                if (documentNavigation(request, reply)) {
                    return;
                }
                const query = new URL(request.url, config.publicOrigin).searchParams;
                const returnUrl = normaliseReturnUrl(query.get('returnUrl') ?? undefined, config);
                const scope = query.get('scope');
                const result = await client.start({
                    returnUrl,
                    cookies: parseBrowserSsoCookies(request.headers.cookie),
                    ...(scope === null ? {} : { scope }),
                    ...(query.get('prompt') === 'login' ? { prompt: 'login' } : {}),
                });
                if (result.kind === 'legacy') {
                    reply.redirect(buildLegacyLoginTarget(config, returnUrl, scope ?? undefined));
                    return;
                }
                applyBrowserSsoCookies(reply, result.cookies);
                if (result.kind === 'error') {
                    fail(reply, result.error, returnUrl);
                    return;
                }
                reply.redirect(result.location);
            });
            sso.get(
                buildGatePath(config, '/sso/callback'),
                async (request, reply): Promise<void> => {
                    if (documentNavigation(request, reply)) {
                        return;
                    }
                    const result = await client.callback({
                        query: new URL(request.url, config.publicOrigin).searchParams,
                        cookies: parseBrowserSsoCookies(request.headers.cookie),
                    });
                    applyBrowserSsoCookies(reply, result.cookies);
                    if (result.kind === 'error') {
                        fail(reply, result.error, result.returnUrl);
                        return;
                    }
                    const remaining = Math.floor(result.auth.exp - Date.now() / 1000);
                    if (remaining < 1) {
                        fail(reply, 'transaction_expired', result.returnUrl);
                        return;
                    }
                    const attributes = buildAuthCookieOptions(config);
                    if (attributes.maxAge !== undefined) {
                        attributes.maxAge = Math.min(attributes.maxAge, remaining);
                    }
                    reply
                        .setCookie(config.cookieName, result.accessToken, attributes)
                        .redirect(normaliseReturnUrl(result.returnUrl, config));
                },
            );
            sso.get(signedOutPath, async (_request, reply): Promise<void> => {
                const central = new URL('/sso/signout', config.serverUrl);
                central.searchParams.set(
                    'returnUri',
                    new URL(signedOutPath, config.publicOrigin).href,
                );
                reply.type('text/html; charset=utf-8').send(
                    renderBrowserSsoPage({
                        title: 'Signed out of this application',
                        message:
                            'Other application sessions keep their normal expiry. You can also end the browser SSO session to prevent new sign-ins without email verification.',
                        stylesPath,
                        nextHref: `${startPath}?${new URLSearchParams({ returnUrl: root })}`,
                        nextText: 'Sign in',
                        ...(config.browserSso.mode === 'off'
                            ? {}
                            : { centralSignOutHref: central.href }),
                    }),
                );
            });
        },
        {
            logSerializers: {
                req(value: unknown): string {
                    const url: unknown =
                        typeof value === 'object' && value !== null
                            ? Reflect.get(value, 'url')
                            : undefined;
                    return typeof url === 'string' ? (url.split('?')[0] ?? '/sso') : '/sso';
                },
            },
        },
    );
}
