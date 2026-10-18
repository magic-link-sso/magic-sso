// SPDX-License-Identifier: MIT

export function isBrowserSsoOpaqueValue(value: unknown): value is string {
    return typeof value === 'string' && /^[A-Za-z0-9_-]{43}$/u.test(value);
}

export function isBrowserSsoCodeVerifier(value: unknown): value is string {
    return typeof value === 'string' && /^[A-Za-z0-9._~-]{43,128}$/u.test(value);
}

export function isBrowserSsoInteger(value: unknown, min: number, max = Infinity): value is number {
    return typeof value === 'number' && Number.isInteger(value) && value >= min && value <= max;
}

export function isBrowserSsoTimestamp(value: unknown): value is number {
    return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;
}
