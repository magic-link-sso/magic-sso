// SPDX-License-Identifier: MIT
import type {
    BrowserSsoClientOptions,
    BrowserSsoCookie,
    BrowserSsoCookieValue,
} from './browser-sso-client.js';
import { createBrowserSsoClient } from './browser-sso-client.js';
import {
    sealBrowserSsoContinuation,
    unsealBrowserSsoContinuation,
} from './browser-sso-continuation.js';
import {
    hashBrowserSsoToken,
    verifyBrowserSsoBootstrapReceipt,
} from './browser-sso-bootstrap-receipt.js';
import {
    unsealBrowserSsoTransaction,
    type BrowserSsoTransactionPayload,
} from './browser-sso-transaction.js';
import { toSecretKey, verifyAuthToken } from './token.js';

export interface BrowserSsoBootstrapContext {
    requestId: string;
    codeVerifier: string;
    redirectUri: string;
}
export interface BrowserSsoPrepared {
    state: string;
    returnUrl: string;
    scope: string;
    context: BrowserSsoBootstrapContext;
    cookies: BrowserSsoCookie[];
}
export interface BrowserSsoBootstrapCompletion {
    kind: 'redirect' | 'local';
    location: string;
    cookies: BrowserSsoCookie[];
}
/** Backend-only continuation primitives, usable with an application's own forms. */
export function createBrowserSsoBootstrapClient(configuration: BrowserSsoClientOptions): {
    prepare(input: {
        query: URLSearchParams;
        cookies: readonly BrowserSsoCookieValue[];
    }): Promise<BrowserSsoPrepared | null>;
    context(
        state: string,
        cookies: readonly BrowserSsoCookieValue[],
    ): Promise<BrowserSsoBootstrapContext | null>;
    complete(input: {
        state: string;
        cookies: readonly BrowserSsoCookieValue[];
        accessToken: string;
        response: unknown;
    }): Promise<BrowserSsoBootstrapCompletion | null>;
    finish(input: {
        query: URLSearchParams;
        cookies: readonly BrowserSsoCookieValue[];
        accessToken?: string;
    }): Promise<BrowserSsoBootstrapCompletion | null>;
} {
    const options = { ...configuration };
    createBrowserSsoClient(options); // Apply the same trusted-origin and policy validation as hosted sign-in.
    const host = options.audience.startsWith('https:') ? '__Host-' : '';
    const txPrefix = `${host}magic-sso-tx-`,
        continuationPrefix = `${host}magic-sso-continuation-`;
    const enabled = (): boolean => options.mode !== 'off' && options.loginUi === 'app-owned';
    const binding = (
        state: string,
    ): { issuer: string; audience: string; redirectUri: string; state: string } => ({
        issuer: options.issuer,
        audience: options.audience,
        redirectUri: options.redirectUri,
        state,
    });
    function cookie(state: string, value: string, expiresAt: number): BrowserSsoCookie {
        return {
            name: continuationPrefix + state,
            value,
            path: '/',
            secure: !!host,
            httpOnly: true,
            sameSite: 'lax',
            maxAge: Math.max(0, Math.ceil((expiresAt - Date.now()) / 1000)),
        };
    }
    function one(cookies: readonly BrowserSsoCookieValue[], name: string): string | undefined {
        const entries = cookies.filter((c) => c.name === name);
        return entries.length === 1 ? entries[0]?.value : undefined;
    }
    async function transaction(
        state: string,
        cookies: readonly BrowserSsoCookieValue[],
    ): Promise<BrowserSsoTransactionPayload | null> {
        if (!enabled() || !/^[A-Za-z0-9_-]{43}$/u.test(state)) {
            return null;
        }
        const value = one(cookies, txPrefix + state);
        const opened = value
            ? await unsealBrowserSsoTransaction(
                  options.secret,
                  txPrefix + state,
                  value,
                  binding(state),
                  Date.now(),
              )
            : null;
        return opened?.kind === 'valid' ? opened.payload : null;
    }
    async function read(
        state: string,
        cookies: readonly BrowserSsoCookieValue[],
    ): Promise<{
        tx: BrowserSsoTransactionPayload;
        continuation: NonNullable<Awaited<ReturnType<typeof unsealBrowserSsoContinuation>>>;
    } | null> {
        const tx = await transaction(state, cookies),
            value = one(cookies, continuationPrefix + state);
        const continuation =
            tx && value
                ? await unsealBrowserSsoContinuation(
                      options.secret,
                      continuationPrefix + state,
                      value,
                      binding(state),
                      tx.expiresAt,
                      Date.now(),
                  )
                : null;
        return tx && continuation ? { tx, continuation } : null;
    }
    function clear(state: string): BrowserSsoCookie[] {
        return [cookie(state, '', 0), { ...cookie(state, '', 0), name: txPrefix + state }];
    }
    function proof(
        tx: BrowserSsoTransactionPayload,
        requestId: string,
    ): BrowserSsoBootstrapContext {
        return { requestId, codeVerifier: tx.codeVerifier, redirectUri: options.redirectUri };
    }
    function parseInspection(
        value: unknown,
        state: string,
        requestId: string,
    ): { scope: string; deadline: number } | null {
        if (typeof value !== 'object' || value === null) {
            return null;
        }
        const scope: unknown = Reflect.get(value, 'scope'),
            deadline: unknown = Reflect.get(value, 'expiresAt');
        if (
            Reflect.get(value, 'state') !== state ||
            Reflect.get(value, 'requestId') !== requestId ||
            typeof scope !== 'string' ||
            new TextEncoder().encode(scope).length > 256 ||
            typeof deadline !== 'number' ||
            !Number.isSafeInteger(deadline) ||
            deadline <= Date.now()
        ) {
            return null;
        }
        return { scope, deadline };
    }
    return {
        async prepare(input): Promise<BrowserSsoPrepared | null> {
            const state = input.query.get('state') ?? '',
                requestId = input.query.get('requestId') ?? '';
            if (
                input.query.getAll('state').length !== 1 ||
                input.query.getAll('requestId').length !== 1 ||
                input.query.getAll('ssoPrepared').length !== 1 ||
                input.query.get('ssoPrepared') !== '1' ||
                !/^[A-Za-z0-9_-]{43}$/u.test(requestId)
            ) {
                return null;
            }
            const tx = await transaction(state, input.cookies);
            if (!tx) {
                return null;
            }
            try {
                const context = proof(tx, requestId);
                const response = await (options.fetcher ?? fetch)(
                    new URL('/sso/bootstrap/inspect', options.issuer),
                    {
                        method: 'POST',
                        headers: { accept: 'application/json', 'content-type': 'application/json' },
                        body: JSON.stringify(context),
                        redirect: 'error',
                        cache: 'no-store',
                        signal: AbortSignal.timeout(options.timeoutMs ?? 5000),
                    },
                );
                const text = await response.text();
                if (!response.ok || response.redirected || text.length > 16_384) {
                    return null;
                }
                const value: unknown = JSON.parse(text);
                const inspection = parseInspection(value, state, requestId);
                if (!inspection) {
                    return null;
                }
                const { scope, deadline } = inspection;
                const expiresAt = Math.min(tx.expiresAt, deadline);
                const sealed = await sealBrowserSsoContinuation(
                    options.secret,
                    continuationPrefix + state,
                    { v: 1, phase: 'prepared', state, requestId, expiresAt },
                    binding(state),
                );
                return {
                    state,
                    returnUrl: tx.returnUrl,
                    scope,
                    context,
                    cookies: [cookie(state, sealed, expiresAt)],
                };
            } catch {
                return null;
            }
        },
        async context(state, cookies): Promise<BrowserSsoBootstrapContext | null> {
            const result = await read(state, cookies);
            return result?.continuation.phase === 'prepared'
                ? proof(result.tx, result.continuation.requestId)
                : null;
        },
        async complete(input): Promise<BrowserSsoBootstrapCompletion | null> {
            const result = await read(input.state, input.cookies);
            if (!result || result.continuation.phase !== 'prepared') {
                return null;
            }
            const auth = await verifyAuthToken(input.accessToken, toSecretKey(options.secret), {
                expectedAudience: options.audience,
                expectedIssuer: options.issuer,
            });
            if (!auth) {
                return null;
            }
            const extension: unknown =
                typeof input.response === 'object' && input.response !== null
                    ? Reflect.get(input.response, 'browserSso')
                    : null;
            const ticket: unknown =
                typeof extension === 'object' && extension !== null
                    ? Reflect.get(extension, 'bootstrapTicket')
                    : null;
            if (typeof ticket !== 'string' || !/^[A-Za-z0-9_-]{43}$/u.test(ticket)) {
                return {
                    kind: 'local',
                    location: result.tx.returnUrl,
                    cookies: clear(input.state),
                };
            }
            const continuation: import('./browser-sso-continuation.js').BrowserSsoContinuation = {
                ...result.continuation,
                phase: 'finish',
                bootstrapTicket: ticket,
                accessTokenHash: await hashBrowserSsoToken(input.accessToken),
            };
            const value = await sealBrowserSsoContinuation(
                options.secret,
                continuationPrefix + input.state,
                continuation,
                binding(input.state),
            );
            const location = new URL('/sso/bootstrap/redeem', options.issuer);
            location.search = new URLSearchParams({
                ticket,
                redirectUri: options.redirectUri,
                state: input.state,
            }).toString();
            return {
                kind: 'redirect',
                location: location.href,
                cookies: [cookie(input.state, value, continuation.expiresAt)],
            };
        },
        async finish(input): Promise<BrowserSsoBootstrapCompletion | null> {
            const state = input.query.get('state') ?? '';
            if (
                input.query.getAll('state').length !== 1 ||
                input.query.getAll('browserSso').length !== 1
            ) {
                return null;
            }
            const result = await read(state, input.cookies);
            if (!result || result.continuation.phase !== 'finish') {
                return null;
            }
            const destination: BrowserSsoBootstrapCompletion = {
                kind: 'local',
                location: result.tx.returnUrl,
                cookies: clear(state),
            };
            if (input.query.get('browserSso') === 'failed') {
                return destination;
            }
            if (
                input.query.get('browserSso') !== 'complete' ||
                input.query.getAll('receipt').length !== 1 ||
                !input.accessToken
            ) {
                return destination;
            }
            const auth = await verifyAuthToken(input.accessToken, toSecretKey(options.secret), {
                expectedAudience: options.audience,
                expectedIssuer: options.issuer,
            });
            if (
                !auth ||
                (await hashBrowserSsoToken(input.accessToken)) !==
                    result.continuation.accessTokenHash
            ) {
                return destination;
            }
            const verified = await verifyBrowserSsoBootstrapReceipt(
                options.secret,
                {
                    ...binding(state),
                    bootstrapTicket: result.continuation.bootstrapTicket,
                    accessTokenHash: result.continuation.accessTokenHash,
                },
                input.query.get('receipt') ?? '',
            );
            return { ...destination, kind: verified ? 'redirect' : 'local' };
        },
    };
}
