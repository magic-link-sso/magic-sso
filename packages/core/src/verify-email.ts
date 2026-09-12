// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Wojciech Polak

import type { VerifyEmailPreviewResponse, VerifyEmailResponse } from './types.js';

/** Narrow a `POST /verify-email` body to the session token the server issued. */
export function isVerifyEmailResponse(value: unknown): value is VerifyEmailResponse {
    return (
        typeof value === 'object' &&
        value !== null &&
        'accessToken' in value &&
        typeof value.accessToken === 'string' &&
        value.accessToken.length > 0
    );
}

/** Narrow a `GET /verify-email` preview body to the recipient it describes. */
export function isVerifyEmailPreviewResponse(value: unknown): value is VerifyEmailPreviewResponse {
    return (
        typeof value === 'object' &&
        value !== null &&
        'email' in value &&
        typeof value.email === 'string' &&
        value.email.length > 0
    );
}
