// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Wojciech Polak
import { deriveBrowserSsoKey } from './browser-sso-key.js';
/** Completion evidence only: a receipt never authenticates an application request. */
export interface BrowserSsoBootstrapReceiptContext {
    issuer: string;
    audience: string;
    redirectUri: string;
    state: string;
    bootstrapTicket: string;
    accessTokenHash: string;
}
function base64url(bytes: Uint8Array): string {
    return btoa(String.fromCharCode(...bytes))
        .replaceAll('+', '-')
        .replaceAll('/', '_')
        .replace(/=+$/u, '');
}
export async function hashBrowserSsoToken(value: string): Promise<string> {
    return base64url(
        new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(value))),
    );
}
async function receiptKey(
    secret: string,
    context: BrowserSsoBootstrapReceiptContext,
): Promise<CryptoKey> {
    if (
        secret.length < 32 ||
        !/^[A-Za-z0-9_-]{43}$/u.test(context.state) ||
        !/^[A-Za-z0-9_-]{43}$/u.test(context.bootstrapTicket) ||
        !/^[A-Za-z0-9_-]{43}$/u.test(context.accessTokenHash) ||
        new URL(context.redirectUri).origin !== context.audience
    ) {
        throw new Error('Invalid browser SSO bootstrap receipt context');
    }
    return deriveBrowserSsoKey(
        secret,
        context.issuer,
        `magic-link-sso/browser-sso/v1/bootstrap-receipt\n${context.audience}`,
        { name: 'HMAC', hash: 'SHA-256', length: 256 },
        ['sign', 'verify'],
    );
}
async function message(
    context: BrowserSsoBootstrapReceiptContext,
): Promise<Uint8Array<ArrayBuffer>> {
    return new TextEncoder().encode(
        JSON.stringify({
            v: 1,
            issuer: context.issuer,
            audience: context.audience,
            redirectUri: context.redirectUri,
            state: context.state,
            ticketHash: await hashBrowserSsoToken(context.bootstrapTicket),
            accessTokenHash: context.accessTokenHash,
        }),
    );
}
export async function createBrowserSsoBootstrapReceipt(
    secret: string,
    context: BrowserSsoBootstrapReceiptContext,
): Promise<string> {
    return base64url(
        new Uint8Array(
            await crypto.subtle.sign(
                'HMAC',
                await receiptKey(secret, context),
                await message(context),
            ),
        ),
    );
}
export async function verifyBrowserSsoBootstrapReceipt(
    secret: string,
    context: BrowserSsoBootstrapReceiptContext,
    receipt: string,
): Promise<boolean> {
    try {
        if (!/^[A-Za-z0-9_-]{43}$/u.test(receipt)) {
            return false;
        }
        const signature = Uint8Array.from(
            atob(receipt.replaceAll('-', '+').replaceAll('_', '/') + '='),
            (character) => character.charCodeAt(0),
        );
        if (base64url(signature) !== receipt) {
            return false;
        }
        return await crypto.subtle.verify(
            'HMAC',
            await receiptKey(secret, context),
            signature,
            await message(context),
        );
    } catch {
        return false;
    }
}
