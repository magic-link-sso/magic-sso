// SPDX-License-Identifier: MIT
import { deriveBrowserSsoKey } from './browser-sso-key.js';
import { BROWSER_SSO_LIMITS } from './browser-sso.js';
import type { BrowserSsoTransactionContext } from './browser-sso-transaction.js';

export type BrowserSsoContinuation =
    | {
          v: 1;
          phase: 'prepared';
          state: string;
          requestId: string;
          expiresAt: number;
      }
    | {
          v: 1;
          phase: 'finish';
          state: string;
          requestId: string;
          expiresAt: number;
          bootstrapTicket: string;
          accessTokenHash: string;
      };
function encode(bytes: Uint8Array): string {
    return btoa(String.fromCharCode(...bytes))
        .replaceAll('+', '-')
        .replaceAll('/', '_')
        .replace(/=+$/u, '');
}
function decode(value: string): Uint8Array<ArrayBuffer> {
    if (!/^[A-Za-z0-9_-]+$/u.test(value)) {
        throw new Error('Invalid continuation');
    }
    const result = Uint8Array.from(
        atob(
            value.replaceAll('-', '+').replaceAll('_', '/') +
                '='.repeat((4 - (value.length % 4)) % 4),
        ),
        (c) => c.charCodeAt(0),
    );
    if (encode(result) !== value) {
        throw new Error('Noncanonical continuation');
    }
    return result;
}
function parse(value: unknown): BrowserSsoContinuation | null {
    if (typeof value !== 'object' || value === null) {
        return null;
    }
    const read = (key: string): unknown => Reflect.get(value, key);
    const v = read('v'),
        phase = read('phase'),
        state = read('state'),
        requestId = read('requestId'),
        expiresAt = read('expiresAt');
    const opaque = (s: unknown): s is string =>
        typeof s === 'string' && /^[A-Za-z0-9_-]{43}$/u.test(s);
    if (
        v !== 1 ||
        !opaque(state) ||
        !opaque(requestId) ||
        typeof expiresAt !== 'number' ||
        !Number.isSafeInteger(expiresAt) ||
        expiresAt <= 0
    ) {
        return null;
    }
    if (phase === 'prepared' && Object.keys(value).length === 5) {
        return { v, phase, state, requestId, expiresAt };
    }
    const bootstrapTicket = read('bootstrapTicket'),
        accessTokenHash = read('accessTokenHash');
    return phase === 'finish' &&
        Object.keys(value).length === 7 &&
        opaque(bootstrapTicket) &&
        opaque(accessTokenHash)
        ? { v, phase, state, requestId, expiresAt, bootstrapTicket, accessTokenHash }
        : null;
}
async function key(secret: string, context: BrowserSsoTransactionContext): Promise<CryptoKey> {
    if (secret.length < 32) {
        throw new Error('Invalid continuation key');
    }
    return deriveBrowserSsoKey(
        secret,
        context.issuer,
        `magic-link-sso/browser-sso/v1/continuation\n${context.audience}\n${context.redirectUri}`,
        { name: 'AES-GCM', length: 256 },
        ['encrypt', 'decrypt'],
    );
}
export async function sealBrowserSsoContinuation(
    secret: string,
    name: string,
    payload: BrowserSsoContinuation,
    context: BrowserSsoTransactionContext,
): Promise<string> {
    if (!parse(payload) || payload.state !== context.state) {
        throw new Error('Invalid continuation');
    }
    const iv = crypto.getRandomValues(new Uint8Array(12));
    const ciphertext = new Uint8Array(
        await crypto.subtle.encrypt(
            { name: 'AES-GCM', iv, additionalData: new TextEncoder().encode(name) },
            await key(secret, context),
            new TextEncoder().encode(JSON.stringify(payload)),
        ),
    );
    const result = `v1.${encode(new Uint8Array([...iv, ...ciphertext]))}`;
    if (result.length > BROWSER_SSO_LIMITS.maxTransactionCookieBytes) {
        throw new Error('Continuation too large');
    }
    return result;
}
export async function unsealBrowserSsoContinuation(
    secret: string,
    name: string,
    value: string,
    context: BrowserSsoTransactionContext,
    transactionExpiresAt: number,
    now: number,
): Promise<BrowserSsoContinuation | null> {
    try {
        if (
            !value.startsWith('v1.') ||
            value.length > BROWSER_SSO_LIMITS.maxTransactionCookieBytes
        ) {
            return null;
        }
        const bytes = decode(value.slice(3));
        const plaintext = await crypto.subtle.decrypt(
            {
                name: 'AES-GCM',
                iv: bytes.slice(0, 12),
                additionalData: new TextEncoder().encode(name),
            },
            await key(secret, context),
            bytes.slice(12),
        );
        const json: unknown = JSON.parse(
            new TextDecoder('utf-8', { fatal: true }).decode(plaintext),
        );
        const payload = parse(json);
        return payload &&
            payload.state === context.state &&
            payload.expiresAt <= transactionExpiresAt &&
            payload.expiresAt > now
            ? payload
            : null;
    } catch {
        return null;
    }
}
