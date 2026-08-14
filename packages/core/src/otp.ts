// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Wojciech Polak

import { MagicSsoConfigurationError } from './errors.js';
import { verifyAuthToken } from './token.js';
import type { EmailOtpExchangeResult, ExchangeEmailOtpOptions } from './types.js';

function isAbortError(error: unknown): boolean {
    return error instanceof DOMException && error.name === 'AbortError';
}

function getAccessToken(value: unknown): string | undefined {
    if (typeof value !== 'object' || value === null) {
        return undefined;
    }
    const candidate = Reflect.get(value, 'accessToken');
    return typeof candidate === 'string' && candidate.length > 0 ? candidate : undefined;
}

function otpEndpoint(serverUrl: string): URL {
    try {
        const url = new URL(serverUrl);
        if ((url.protocol !== 'http:' && url.protocol !== 'https:') || url.origin === 'null') {
            throw new Error('not an origin');
        }
        return new URL('/verify-email/otp', url.origin);
    } catch {
        throw new MagicSsoConfigurationError('serverUrl must be an absolute HTTP(S) URL.');
    }
}

export async function exchangeEmailOtp(
    options: ExchangeEmailOtpOptions,
): Promise<EmailOtpExchangeResult> {
    if (options.signal?.aborted === true) {
        return { kind: 'aborted' };
    }

    let response: Response;
    try {
        response = await options.fetcher(otpEndpoint(options.serverUrl), {
            body: JSON.stringify({ challengeId: options.challengeId, code: options.code }),
            cache: 'no-store',
            headers: { accept: 'application/json', 'content-type': 'application/json' },
            method: 'POST',
            signal: options.signal,
        });
    } catch (error: unknown) {
        return isAbortError(error) ? { kind: 'aborted' } : { kind: 'network-error' };
    }

    let responseBody: unknown;
    try {
        responseBody = await response.json();
    } catch {
        return response.ok
            ? { kind: 'response-error', reason: 'invalid-json', status: response.status }
            : { kind: 'rejected', status: response.status };
    }
    if (!response.ok) {
        return { kind: 'rejected', status: response.status };
    }

    const accessToken = getAccessToken(responseBody);
    if (typeof accessToken === 'undefined') {
        return { kind: 'response-error', reason: 'missing-access-token', status: response.status };
    }

    const auth = await verifyAuthToken(accessToken, options.secret, {
        expectedAudience: options.expectedAudience,
        expectedIssuer: options.expectedIssuer,
    });
    return auth === null ? { kind: 'verification-error' } : { accessToken, auth, kind: 'success' };
}
