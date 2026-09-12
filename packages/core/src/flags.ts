// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Wojciech Polak

const TRUTHY_FLAG_VALUES = new Set(['1', 'true', 'yes', 'on']);
const FALSY_FLAG_VALUES = new Set(['0', 'false', 'no', 'off']);

/**
 * Interpret an environment variable or runtime-config entry as a boolean flag.
 *
 * Booleans pass through; strings are matched case-insensitively against the
 * accepted spellings (`1`/`true`/`yes`/`on` and `0`/`false`/`no`/`off`).
 * Anything else, including an unrecognised spelling, answers `fallback`.
 */
export function parseBooleanFlag(value: unknown, fallback = false): boolean {
    if (typeof value === 'boolean') {
        return value;
    }
    if (typeof value !== 'string') {
        return fallback;
    }

    const normalised = value.trim().toLowerCase();
    if (TRUTHY_FLAG_VALUES.has(normalised)) {
        return true;
    }
    if (FALSY_FLAG_VALUES.has(normalised)) {
        return false;
    }

    return fallback;
}
