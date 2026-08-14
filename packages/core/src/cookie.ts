// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Wojciech Polak

import { MagicSsoConfigurationError } from './errors.js';
import type { AuthCookieOptions, BuildAuthCookieOptions, ReadCookieValueOptions } from './types.js';

function decodeCookieValue(value: string): string {
    try {
        return decodeURIComponent(value);
    } catch {
        return value;
    }
}

function validateCookieName(name: string): void {
    if (name.length === 0 || /[\s;=]/u.test(name)) {
        throw new MagicSsoConfigurationError(
            'Cookie name must not contain whitespace, semicolons, or equals signs.',
        );
    }
}

export function readCookieValue(
    cookieHeader: string | null | undefined,
    name: string,
    options: ReadCookieValueOptions = {},
): string | undefined {
    validateCookieName(name);
    if (typeof cookieHeader !== 'string' || cookieHeader.length === 0) {
        return undefined;
    }

    const prefix = `${name}=`;
    let matchedValue: string | undefined;
    for (const item of cookieHeader.split(';')) {
        const trimmedItem = item.trim();
        if (trimmedItem.startsWith(prefix)) {
            const decodedValue = decodeCookieValue(trimmedItem.slice(prefix.length));
            if (options.lastMatch === true) {
                matchedValue = decodedValue;
                continue;
            }
            return decodedValue;
        }
    }
    return matchedValue;
}

export function buildAuthCookieOptions(options: BuildAuthCookieOptions): AuthCookieOptions {
    validateCookieName(options.name);
    const path = options.path ?? '/';
    if (!path.startsWith('/')) {
        throw new MagicSsoConfigurationError('Cookie path must start with "/".');
    }
    if (
        typeof options.maxAge === 'number' &&
        (!Number.isInteger(options.maxAge) || options.maxAge <= 0)
    ) {
        throw new MagicSsoConfigurationError('Cookie maxAge must be a positive integer.');
    }

    return {
        httpOnly: true,
        ...(typeof options.maxAge === 'number' ? { maxAge: options.maxAge } : {}),
        name: options.name,
        path,
        sameSite: 'lax',
        secure: options.secure,
        value: options.value,
    };
}
