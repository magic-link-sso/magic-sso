// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Wojciech Polak

/**
 * Sign-in response helpers shared by the TypeScript example apps. Each example
 * re-exports these from its own `signin-utils` module so the framework-specific
 * wording stays local while the parsing rules stay in one place.
 */

/**
 * Read a non-empty `message` string out of an arbitrary JSON response body.
 *
 * @param {unknown} value Parsed response body.
 * @returns {string | null} The message, or `null` when there is none.
 */
export function readMessage(value) {
    if (typeof value !== 'object' || value === null) {
        return null;
    }

    const message = /** @type {Record<string, unknown>} */ (value)['message'];
    return typeof message === 'string' && message.length > 0 ? message : null;
}

/**
 * Build a failure payload, preferring the server's own message.
 *
 * @param {unknown} payload Parsed response body.
 * @param {string} [fallback] Message to use when the body carries none.
 * @returns {{ message: string }}
 */
export function buildFailureResult(payload, fallback = 'Failed to send verification email.') {
    return {
        message: readMessage(payload) ?? fallback,
    };
}

/**
 * Explain why `serverUrl` cannot be the Magic Link SSO server for this app.
 *
 * @param {string} serverUrl Value of `MAGICSSO_SERVER_URL`.
 * @param {string} requestOrigin Origin the example app itself is serving from.
 * @param {string} appName Framework name used in the error message.
 * @returns {string | null} The misconfiguration message, or `null` when valid.
 */
export function readServerUrlConfigError(serverUrl, requestOrigin, appName) {
    try {
        const parsedServerUrl = new URL(serverUrl);
        if (parsedServerUrl.origin === requestOrigin) {
            return `MAGICSSO_SERVER_URL points to this ${appName} app. Set it to the Magic Link SSO server, usually http://localhost:3000 for local development.`;
        }
    } catch {
        return 'MAGICSSO_SERVER_URL must be an absolute URL.';
    }

    return null;
}
