// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Wojciech Polak

import {
    BROWSER_SSO_LIMITS,
    parseBrowserSsoCapabilities,
    type BrowserSsoCapabilityResult,
    type BrowserSsoMode,
    type BrowserSsoCapabilities,
} from './browser-sso.js';
import {
    createBrowserSsoCodeChallenge,
    createBrowserSsoRandomValue,
    sealBrowserSsoTransaction,
    unsealBrowserSsoTransaction,
    type BrowserSsoTransactionPayload,
} from './browser-sso-transaction.js';
import { unsealBrowserSsoContinuation } from './browser-sso-continuation.js';
import { MagicSsoConfigurationError } from './errors.js';
import { normaliseReturnUrl } from './return-url.js';
import { toSecretKey, verifyAuthToken } from './token.js';
import type { AuthPayload } from './types.js';

export interface BrowserSsoCookieValue {
    name: string;
    value: string;
}

/** Keep duplicate names visible so callbacks reject ambiguous cookie headers. */
export function parseBrowserSsoCookies(header: string | null | undefined): BrowserSsoCookieValue[] {
    if (!header) {
        return [];
    }
    return header.split(';').flatMap((item) => {
        const separator = item.indexOf('=');
        if (separator < 1) {
            return [];
        }
        const name = item.slice(0, separator).trim();
        const raw = item.slice(separator + 1).trim();
        try {
            return [{ name, value: decodeURIComponent(raw) }];
        } catch {
            return [{ name, value: raw }];
        }
    });
}
export interface BrowserSsoCookie extends BrowserSsoCookieValue {
    httpOnly: true;
    secure: boolean;
    sameSite: 'lax';
    path: '/';
    maxAge: number;
}
export interface BrowserSsoClientOptions {
    mode: BrowserSsoMode;
    loginUi?: 'hosted' | 'app-owned';
    issuer: string;
    audience: string;
    redirectUri: string;
    secret: string;
    allowInsecureLocalhost?: boolean;
    timeoutMs?: number;
    fetcher?: typeof fetch;
}
export type BrowserSsoClientError =
    | 'invalid_request'
    | 'invalid_transaction'
    | 'transaction_expired'
    | 'transaction_limit'
    | 'transaction_too_large'
    | 'sso_required'
    | 'temporarily_unavailable'
    | 'exchange_failed'
    | 'invalid_token'
    | 'sso_disabled'
    | 'access_denied';
export interface BrowserSsoClientFailure {
    kind: 'error';
    error: BrowserSsoClientError;
    cookies: BrowserSsoCookie[];
    /** Trusted app destination for an explicit restart; a code is never retried. */
    returnUrl?: string;
}
export type BrowserSsoStartResult =
    | BrowserSsoClientFailure
    | { kind: 'legacy'; reason: 'off' | 'disabled' | 'unsupported' | 'not_found' }
    | { kind: 'redirect'; location: string; cookies: BrowserSsoCookie[] };
export type BrowserSsoCallbackResult =
    | BrowserSsoClientFailure
    | {
          kind: 'authenticated';
          accessToken: string;
          auth: AuthPayload;
          returnUrl: string;
          cookies: BrowserSsoCookie[];
      };
export interface BrowserSsoClient {
    start(input: {
        returnUrl: string;
        cookies: readonly BrowserSsoCookieValue[];
        scope?: string;
        prompt?: 'login';
        restarts?: 0 | 1;
        /** Explicit recovery may choose the hosted UI without downgrading the protocol. */
        loginUi?: 'hosted';
    }): Promise<BrowserSsoStartResult>;
    callback(input: {
        query: URLSearchParams;
        cookies: readonly BrowserSsoCookieValue[];
    }): Promise<BrowserSsoCallbackResult>;
}

type DiscoveryResult =
    | Exclude<BrowserSsoCapabilityResult, { kind: 'malformed' }>
    | { kind: 'not_found' };

/** Framework prefetch/RSC fetches must not create or consume auth transactions. */
export function isBrowserSsoDocumentNavigation(headers: Pick<Headers, 'get'>): boolean {
    const mode = headers.get('sec-fetch-mode');
    const destination = headers.get('sec-fetch-dest');
    const purpose = `${headers.get('purpose') ?? ''} ${headers.get('sec-purpose') ?? ''}`;
    return (
        !headers.get('rsc') &&
        !headers.get('next-router-prefetch') &&
        !headers.get('next-router-segment-prefetch') &&
        !/prefetch|prerender/iu.test(purpose) &&
        (mode === null || mode === 'navigate') &&
        (destination === null || destination === 'document')
    );
}

function localhost(hostname: string): boolean {
    return (
        hostname === 'localhost' ||
        hostname.endsWith('.localhost') ||
        hostname === '127.0.0.1' ||
        hostname === '[::1]'
    );
}

function validateBrowserSsoUrl(url: URL, allowInsecureLocalhost: boolean | undefined): void {
    if (
        url.username ||
        url.password ||
        url.search ||
        url.hash ||
        url.hostname.endsWith('.') ||
        (url.protocol !== 'https:' &&
            !(
                url.protocol === 'http:' &&
                allowInsecureLocalhost === true &&
                localhost(url.hostname)
            ))
    ) {
        throw new Error('Unsafe browser SSO URL');
    }
}

function validateOptions(options: BrowserSsoClientOptions): void {
    if (!['off', 'auto', 'required'].includes(options.mode)) {
        throw new MagicSsoConfigurationError('Invalid browser SSO mode.');
    }
    if (options.mode === 'off') {
        return;
    }
    if (
        options.loginUi !== undefined &&
        options.loginUi !== 'hosted' &&
        options.loginUi !== 'app-owned'
    ) {
        throw new MagicSsoConfigurationError('Invalid browser SSO login UI.');
    }
    try {
        const issuer = new URL(options.issuer),
            audience = new URL(options.audience),
            callback = new URL(options.redirectUri);
        for (const url of [issuer, audience, callback]) {
            validateBrowserSsoUrl(url, options.allowInsecureLocalhost);
        }
        if (
            issuer.origin !== options.issuer ||
            audience.origin !== options.audience ||
            callback.href !== options.redirectUri ||
            callback.origin !== audience.origin ||
            issuer.hostname === audience.hostname ||
            options.secret.length < 32
        ) {
            throw new Error('Invalid browser SSO origins or secret');
        }
        const timeout = options.timeoutMs ?? 5000;
        if (!Number.isInteger(timeout) || timeout < 100 || timeout > 30_000) {
            throw new Error('Invalid browser SSO timeout');
        }
    } catch {
        throw new MagicSsoConfigurationError(
            'Browser SSO requires distinct issuer/app hostnames, exact HTTPS URLs, and a JWT secret of at least 32 characters. Local HTTP requires allowInsecureLocalhost. Timeout must be 100–30000 ms.',
        );
    }
}

async function readDocument(response: Response): Promise<unknown> {
    const body = await response.text();
    if (body.length > 16_384) {
        throw new Error('Browser SSO response exceeds size limit');
    }
    const value: unknown = JSON.parse(body);
    return value;
}

function readString(value: unknown, field: string): string | undefined {
    if (typeof value !== 'object' || value === null) {
        return undefined;
    }
    const result: unknown = Reflect.get(value, field);
    return typeof result === 'string' ? result : undefined;
}

/** Hosted-first flow. Every exchange happens on the backend and is attempted once. */
export function createBrowserSsoClient(configuration: BrowserSsoClientOptions): BrowserSsoClient {
    const options = { ...configuration };
    validateOptions(options);
    const prefix = `${options.audience.startsWith('https:') ? '__Host-' : ''}magic-sso-tx-`;
    let cached: { expiresAt: number; result: DiscoveryResult } | undefined;

    function cookie(name: string, value: string, maxAge: number): BrowserSsoCookie {
        return {
            name,
            value,
            maxAge,
            httpOnly: true,
            secure: options.audience.startsWith('https:'),
            sameSite: 'lax',
            path: '/',
        };
    }
    async function discover(): Promise<DiscoveryResult> {
        if (cached && cached.expiresAt > Date.now()) {
            return cached.result;
        }
        const response = await (options.fetcher ?? fetch)(
            new URL('/sso/capabilities', options.issuer),
            {
                headers: { accept: 'application/json' },
                redirect: 'error',
                cache: 'no-store',
                signal: AbortSignal.timeout(options.timeoutMs ?? 5000),
            },
        );
        if (response.redirected) {
            throw new Error('Unexpected capability redirect');
        }
        const result: BrowserSsoCapabilityResult | { kind: 'not_found' } | null =
            response.status === 404
                ? { kind: 'not_found' }
                : response.ok
                  ? parseBrowserSsoCapabilities(await readDocument(response))
                  : null;
        if (!result || result.kind === 'malformed') {
            throw new Error('Invalid browser SSO capabilities');
        }
        cached = {
            expiresAt: Date.now() + BROWSER_SSO_LIMITS.capabilityCacheSeconds * 1000,
            result,
        };
        return result;
    }
    async function open(
        entry: BrowserSsoCookieValue,
        now: number,
    ): ReturnType<typeof unsealBrowserSsoTransaction> {
        const state = entry.name.slice(prefix.length);
        return unsealBrowserSsoTransaction(
            options.secret,
            entry.name,
            entry.value,
            {
                state,
                issuer: options.issuer,
                audience: options.audience,
                redirectUri: options.redirectUri,
            },
            now,
        );
    }

    async function startSupported(
        input: Parameters<BrowserSsoClient['start']>[0],
        capabilities: BrowserSsoCapabilities,
        context: {
            returnUrl: string;
            scope: string | undefined;
            loginUi: BrowserSsoClientOptions['loginUi'];
        },
        cookies: BrowserSsoCookie[],
    ): Promise<BrowserSsoStartResult> {
        const { returnUrl, scope, loginUi } = context;
        const now = Date.now();
        const pending = new Set<string>();
        for (const entry of input.cookies) {
            if (!entry.name.startsWith(prefix)) {
                continue;
            }
            const transaction = await open(entry, now);
            if (transaction?.kind === 'expired') {
                cookies.push(cookie(entry.name, '', 0));
            } else if (transaction?.kind === 'valid') {
                pending.add(entry.name);
            }
        }
        if (pending.size >= BROWSER_SSO_LIMITS.maxPendingAppTransactions) {
            return { kind: 'error', error: 'transaction_limit', cookies };
        }
        const state = createBrowserSsoRandomValue(),
            codeVerifier = createBrowserSsoRandomValue();
        const name = `${prefix}${state}`;
        let sealed: string;
        try {
            sealed = await sealBrowserSsoTransaction(options.secret, name, {
                v: 1,
                state,
                codeVerifier,
                returnUrl,
                issuer: options.issuer,
                audience: options.audience,
                redirectUri: options.redirectUri,
                createdAt: now,
                expiresAt: now + capabilities.transactionLifetimeSeconds * 1000,
                restarts: input.restarts ?? 0,
            });
        } catch (error) {
            if (error instanceof Error && error.message.includes('too large')) {
                return { kind: 'error', error: 'transaction_too_large', cookies };
            }
            throw error;
        }
        const location = new URL('/sso/authorize', options.issuer);
        location.search = new URLSearchParams({
            redirectUri: options.redirectUri,
            state,
            codeChallenge: await createBrowserSsoCodeChallenge(codeVerifier),
            codeChallengeMethod: 'S256',
            ...(scope ? { scope } : {}),
            ...(input.prompt ? { prompt: input.prompt } : {}),
            ...(loginUi === 'app-owned' ? { loginUi: 'app-owned' } : {}),
        }).toString();
        cookies.push(cookie(name, sealed, capabilities.transactionLifetimeSeconds));
        return { kind: 'redirect', location: location.href, cookies };
    }

    async function exchangeCode(
        code: string,
        payload: BrowserSsoTransactionPayload,
        cookies: BrowserSsoCookie[],
    ): Promise<BrowserSsoCallbackResult> {
        const failure = (error: BrowserSsoClientError): BrowserSsoClientFailure => ({
            kind: 'error',
            error,
            cookies,
            returnUrl: payload.returnUrl,
        });
        try {
            const response = await (options.fetcher ?? fetch)(
                new URL('/sso/exchange', options.issuer),
                {
                    method: 'POST',
                    headers: { accept: 'application/json', 'content-type': 'application/json' },
                    body: JSON.stringify({
                        code,
                        codeVerifier: payload.codeVerifier,
                        redirectUri: options.redirectUri,
                    }),
                    redirect: 'error',
                    cache: 'no-store',
                    signal: AbortSignal.timeout(options.timeoutMs ?? 5000),
                },
            );
            if (!response.ok || response.redirected) {
                return failure(response.status === 403 ? 'access_denied' : 'exchange_failed');
            }
            const accessToken = readString(await readDocument(response), 'accessToken');
            if (!accessToken) {
                return failure('invalid_token');
            }
            const auth = await verifyAuthToken(accessToken, toSecretKey(options.secret), {
                expectedAudience: options.audience,
                expectedIssuer: options.issuer,
            });
            if (!auth) {
                return failure('invalid_token');
            }
            return {
                kind: 'authenticated',
                accessToken,
                auth,
                returnUrl: payload.returnUrl,
                cookies,
            };
        } catch {
            // The issuer may have consumed the code. Only a fresh transaction
            // can recover; do not retry exchange or fall back to email proof.
            return failure('exchange_failed');
        }
    }

    async function clearContinuation(
        name: string,
        payload: BrowserSsoTransactionPayload,
        inputCookies: readonly BrowserSsoCookieValue[],
        cookies: BrowserSsoCookie[],
    ): Promise<void> {
        const continuationName = name.replace('magic-sso-tx-', 'magic-sso-continuation-');
        const continuations = inputCookies.filter((entry) => entry.name === continuationName);
        if (
            continuations.length === 1 &&
            continuations[0] &&
            (await unsealBrowserSsoContinuation(
                options.secret,
                continuationName,
                continuations[0].value,
                payload,
                payload.expiresAt,
                Date.now(),
            ))
        ) {
            cookies.push(cookie(continuationName, '', 0));
        }
    }

    return {
        async start(input): Promise<BrowserSsoStartResult> {
            if (options.mode === 'off') {
                return { kind: 'legacy', reason: 'off' };
            }
            const cookies: BrowserSsoCookie[] = [];
            const returnUrl = normaliseReturnUrl({
                appOrigin: options.audience,
                returnUrl: input.returnUrl,
            });
            if (
                new TextEncoder().encode(returnUrl).byteLength >
                BROWSER_SSO_LIMITS.maxReturnUrlBytes
            ) {
                return { kind: 'error', error: 'transaction_too_large', cookies };
            }
            const scope = input.scope?.trim();
            if (scope !== undefined && new TextEncoder().encode(scope).byteLength > 256) {
                return { kind: 'error', error: 'invalid_request', cookies };
            }
            try {
                const capabilities = await discover();
                const loginUi = input.loginUi === 'hosted' ? 'hosted' : options.loginUi;
                if (
                    capabilities.kind !== 'supported' ||
                    (loginUi === 'app-owned' &&
                        capabilities.capabilities.appOwnedBootstrapVersion !== 1)
                ) {
                    return options.mode === 'auto'
                        ? {
                              kind: 'legacy',
                              reason:
                                  capabilities.kind === 'supported'
                                      ? 'unsupported'
                                      : capabilities.kind,
                          }
                        : { kind: 'error', error: 'sso_required', cookies };
                }
                return await startSupported(
                    input,
                    capabilities.capabilities,
                    { returnUrl, scope, loginUi },
                    cookies,
                );
            } catch {
                return { kind: 'error', error: 'temporarily_unavailable', cookies };
            }
        },
        async callback(input): Promise<BrowserSsoCallbackResult> {
            if (options.mode === 'off') {
                return { kind: 'error', error: 'sso_disabled', cookies: [] };
            }
            const state = input.query.get('state');
            if (
                !state ||
                !/^[A-Za-z0-9_-]{43}$/u.test(state) ||
                input.query.getAll('state').length !== 1
            ) {
                return { kind: 'error', error: 'invalid_transaction', cookies: [] };
            }
            const name = `${prefix}${state}`;
            const entries = input.cookies.filter((entry) => entry.name === name);
            const entry = entries.length === 1 ? entries[0] : undefined;
            const transaction = entry === undefined ? null : await open(entry, Date.now());
            if (!transaction) {
                return { kind: 'error', error: 'invalid_transaction', cookies: [] };
            }
            const cookies = [cookie(name, '', 0)];
            await clearContinuation(name, transaction.payload, input.cookies, cookies);
            const failure = (error: BrowserSsoClientError): BrowserSsoClientFailure => ({
                kind: 'error',
                error,
                cookies,
                returnUrl: transaction.payload.returnUrl,
            });
            if (transaction.kind === 'expired') {
                return failure('transaction_expired');
            }
            const returnedError = input.query.get('error');
            if (returnedError !== null) {
                return failure(
                    returnedError === 'access_denied' ? 'access_denied' : 'exchange_failed',
                );
            }
            const code = input.query.get('code');
            if (
                !code ||
                !/^[A-Za-z0-9_-]{43}$/u.test(code) ||
                input.query.getAll('code').length !== 1
            ) {
                return failure('invalid_request');
            }
            return exchangeCode(code, transaction.payload, cookies);
        },
    };
}
