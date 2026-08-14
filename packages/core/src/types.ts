// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Wojciech Polak

import type { JWTPayload } from 'jose';

export interface AuthPayload extends JWTPayload {
    aud: string | string[];
    email: string;
    exp: number;
    iat: number;
    iss: string;
    jti: string;
    scope: string;
    siteId: string;
}

export interface VerifyAuthTokenOptions {
    expectedAudience: string;
    expectedIssuer: string;
}

export interface AuthCookieOptions {
    httpOnly: true;
    maxAge?: number;
    name: string;
    path: string;
    sameSite: 'lax';
    secure: boolean;
    value: string;
}

export interface BuildAuthCookieOptions {
    maxAge?: number;
    name: string;
    path?: string;
    secure: boolean;
    value: string;
}

export interface ReadCookieValueOptions {
    lastMatch?: boolean;
}

export interface ExchangeEmailOtpOptions {
    challengeId: string;
    code: string;
    expectedAudience: string;
    expectedIssuer: string;
    fetcher: typeof fetch;
    secret: Uint8Array;
    serverUrl: string;
    signal?: AbortSignal;
}

export interface EmailOtpExchangeSuccess {
    accessToken: string;
    auth: AuthPayload;
    kind: 'success';
}

export interface EmailOtpExchangeRejected {
    kind: 'rejected';
    status: number;
}

export interface EmailOtpExchangeResponseError {
    kind: 'response-error';
    reason: 'invalid-json' | 'missing-access-token';
    status: number;
}

export interface EmailOtpExchangeVerificationError {
    kind: 'verification-error';
}

export interface EmailOtpExchangeNetworkError {
    kind: 'network-error';
}

export interface EmailOtpExchangeAborted {
    kind: 'aborted';
}

export type EmailOtpExchangeResult =
    | EmailOtpExchangeSuccess
    | EmailOtpExchangeRejected
    | EmailOtpExchangeResponseError
    | EmailOtpExchangeVerificationError
    | EmailOtpExchangeNetworkError
    | EmailOtpExchangeAborted;

export interface NormaliseReturnUrlOptions {
    appOrigin: string;
    fallback?: string;
    returnUrl: string | undefined;
}

export interface BuildLoginTargetOptions {
    appOrigin: string;
    directUse?: boolean;
    loginPath?: string;
    returnUrl: string | undefined;
    scope?: string;
    serverUrl?: string;
}
