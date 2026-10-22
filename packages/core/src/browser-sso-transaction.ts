// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Wojciech Polak
import { deriveBrowserSsoKey } from './browser-sso-key.js';

import { BROWSER_SSO_LIMITS } from './browser-sso.js';
import {
    isBrowserSsoOpaqueValue,
    isBrowserSsoCodeVerifier,
    isBrowserSsoTimestamp,
} from './browser-sso-validation.js';

export interface BrowserSsoTransactionPayload {
    v: 1;
    state: string;
    codeVerifier: string;
    returnUrl: string;
    issuer: string;
    audience: string;
    redirectUri: string;
    createdAt: number;
    expiresAt: number;
    restarts: 0 | 1;
}

export interface BrowserSsoTransactionContext {
    state: string;
    issuer: string;
    audience: string;
    redirectUri: string;
}

function encodeBase64Url(value: Uint8Array): string {
    let binary = '';
    for (const byte of value) {
        binary += String.fromCharCode(byte);
    }
    return btoa(binary).replaceAll('+', '-').replaceAll('/', '_').replace(/=+$/u, '');
}

function decodeBase64Url(value: string): Uint8Array<ArrayBuffer> {
    if (!/^[A-Za-z0-9_-]+$/u.test(value)) {
        throw new Error('Invalid base64url');
    }
    const binary = atob(
        value.replaceAll('-', '+').replaceAll('_', '/') + '='.repeat((4 - (value.length % 4)) % 4),
    );
    const bytes = Uint8Array.from(binary, (character) => character.charCodeAt(0));
    if (encodeBase64Url(bytes) !== value) {
        throw new Error('Noncanonical base64url');
    }
    return bytes;
}

export function createBrowserSsoRandomValue(): string {
    return encodeBase64Url(crypto.getRandomValues(new Uint8Array(32)));
}

export async function createBrowserSsoCodeChallenge(verifier: string): Promise<string> {
    if (!/^[A-Za-z0-9._~-]{43,128}$/u.test(verifier)) {
        throw new Error('Invalid PKCE verifier');
    }
    return encodeBase64Url(
        new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(verifier))),
    );
}

function validTransactionUrls(
    issuer: string,
    audience: string,
    returnUrl: string,
    redirectUri: string,
): boolean {
    try {
        const origin = new URL(audience),
            issuerUrl = new URL(issuer),
            destination = new URL(returnUrl),
            callback = new URL(redirectUri);
        return (
            origin.origin === audience &&
            issuerUrl.origin === issuer &&
            origin.hostname !== issuerUrl.hostname &&
            ['http:', 'https:'].includes(origin.protocol) &&
            ['http:', 'https:'].includes(issuerUrl.protocol) &&
            destination.origin === audience &&
            !destination.username &&
            !destination.password &&
            callback.origin === audience &&
            !callback.username &&
            !callback.password &&
            !callback.hash &&
            !callback.search
        );
    } catch {
        return false;
    }
}

function parsePayload(value: unknown): BrowserSsoTransactionPayload | null {
    if (typeof value !== 'object' || value === null) {
        return null;
    }
    const read = (name: string): unknown => Reflect.get(value, name);
    const v = read('v'),
        state = read('state'),
        codeVerifier = read('codeVerifier');
    const returnUrl = read('returnUrl'),
        issuer = read('issuer'),
        audience = read('audience'),
        redirectUri = read('redirectUri');
    const createdAt = read('createdAt'),
        expiresAt = read('expiresAt'),
        restarts = read('restarts');
    if (
        Object.keys(value).length !== 10 ||
        v !== 1 ||
        !isBrowserSsoOpaqueValue(state) ||
        !isBrowserSsoCodeVerifier(codeVerifier) ||
        typeof returnUrl !== 'string' ||
        new TextEncoder().encode(returnUrl).byteLength > BROWSER_SSO_LIMITS.maxReturnUrlBytes ||
        typeof issuer !== 'string' ||
        typeof audience !== 'string' ||
        typeof redirectUri !== 'string' ||
        !isBrowserSsoTimestamp(createdAt) ||
        !isBrowserSsoTimestamp(expiresAt) ||
        expiresAt <= createdAt ||
        expiresAt - createdAt >
            (BROWSER_SSO_LIMITS.maxRequestSeconds +
                BROWSER_SSO_LIMITS.maxCodeSeconds +
                BROWSER_SSO_LIMITS.clockAllowanceSeconds) *
                1000 ||
        (restarts !== 0 && restarts !== 1)
    ) {
        return null;
    }
    if (!validTransactionUrls(issuer, audience, returnUrl, redirectUri)) {
        return null;
    }
    return {
        v,
        state,
        codeVerifier,
        returnUrl,
        issuer,
        audience,
        redirectUri,
        createdAt,
        expiresAt,
        restarts,
    };
}

async function transactionKey(
    secret: string,
    issuer: string,
    audience: string,
): Promise<CryptoKey> {
    if (secret.length < 32) {
        throw new Error('Browser SSO requires a JWT secret of at least 32 characters');
    }
    return deriveBrowserSsoKey(
        secret,
        issuer,
        `magic-link-sso/browser-sso/v1/transaction\n${audience}`,
        { name: 'AES-GCM', length: 256 },
        ['encrypt', 'decrypt'],
    );
}

export async function sealBrowserSsoTransaction(
    secret: string,
    cookieName: string,
    payload: BrowserSsoTransactionPayload,
): Promise<string> {
    if (!parsePayload(payload)) {
        throw new Error('Invalid browser SSO transaction');
    }
    const nonce = crypto.getRandomValues(new Uint8Array(12));
    const ciphertext = new Uint8Array(
        await crypto.subtle.encrypt(
            {
                name: 'AES-GCM',
                iv: nonce,
                additionalData: new TextEncoder().encode(cookieName),
                tagLength: 128,
            },
            await transactionKey(secret, payload.issuer, payload.audience),
            new TextEncoder().encode(JSON.stringify(payload)),
        ),
    );
    const envelope = new Uint8Array(nonce.byteLength + ciphertext.byteLength);
    envelope.set(nonce);
    envelope.set(ciphertext, nonce.byteLength);
    const result = `v1.${encodeBase64Url(envelope)}`;
    if (result.length > BROWSER_SSO_LIMITS.maxTransactionCookieBytes) {
        throw new Error('Browser SSO transaction is too large');
    }
    return result;
}

export async function unsealBrowserSsoTransaction(
    secret: string,
    cookieName: string,
    value: string,
    context: BrowserSsoTransactionContext,
    now: number,
): Promise<{ kind: 'valid' | 'expired'; payload: BrowserSsoTransactionPayload } | null> {
    try {
        if (
            !value.startsWith('v1.') ||
            value.length > BROWSER_SSO_LIMITS.maxTransactionCookieBytes
        ) {
            return null;
        }
        const bytes = decodeBase64Url(value.slice(3));
        if (bytes.byteLength < 29) {
            return null;
        }
        const plaintext = await crypto.subtle.decrypt(
            {
                name: 'AES-GCM',
                iv: bytes.slice(0, 12),
                additionalData: new TextEncoder().encode(cookieName),
                tagLength: 128,
            },
            await transactionKey(secret, context.issuer, context.audience),
            bytes.slice(12),
        );
        const json: unknown = JSON.parse(
            new TextDecoder('utf-8', { fatal: true }).decode(plaintext),
        );
        const payload = parsePayload(json);
        if (
            !payload ||
            payload.state !== context.state ||
            payload.issuer !== context.issuer ||
            payload.audience !== context.audience ||
            payload.redirectUri !== context.redirectUri ||
            payload.createdAt > now + BROWSER_SSO_LIMITS.clockAllowanceSeconds * 1000
        ) {
            return null;
        }
        return { kind: payload.expiresAt <= now ? 'expired' : 'valid', payload };
    } catch {
        return null;
    }
}
