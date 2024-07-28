// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Wojciech Polak

interface MessagePayload {
    message: string;
}

function asRecord(value: unknown): Record<string, unknown> | null {
    if (typeof value !== 'object' || value === null) {
        return null;
    }

    return value as Record<string, unknown>;
}

export function readMessage(value: unknown): string | null {
    const record = asRecord(value);
    const message = record?.message;

    return typeof message === 'string' && message.length > 0 ? message : null;
}

export function buildFailureResult(
    payload: unknown,
    fallback = 'Failed to send verification email.',
): MessagePayload {
    return {
        message: readMessage(payload) ?? fallback,
    };
}

export function readServerUrlConfigError(serverUrl: string, requestOrigin: string): string | null {
    try {
        const parsedServerUrl = new URL(serverUrl);
        if (parsedServerUrl.origin === requestOrigin) {
            return 'MAGICSSO_SERVER_URL points to this Nuxt app. Set it to the Magic Link SSO server, usually http://localhost:3000 for local development.';
        }
    } catch {
        return 'MAGICSSO_SERVER_URL must be an absolute URL.';
    }

    return null;
}
