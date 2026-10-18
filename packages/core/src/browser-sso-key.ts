// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Wojciech Polak

/** Preserve each protocol purpose's HKDF salt, info, algorithm and permitted uses. */
export async function deriveBrowserSsoKey(
    secret: string,
    issuer: string,
    info: string,
    algorithm: Parameters<SubtleCrypto['deriveKey']>[2],
    usages: KeyUsage[],
): Promise<CryptoKey> {
    const encoder = new TextEncoder();
    const material = await crypto.subtle.importKey('raw', encoder.encode(secret), 'HKDF', false, [
        'deriveKey',
    ]);
    return crypto.subtle.deriveKey(
        { name: 'HKDF', hash: 'SHA-256', salt: encoder.encode(issuer), info: encoder.encode(info) },
        material,
        algorithm,
        false,
        usages,
    );
}
