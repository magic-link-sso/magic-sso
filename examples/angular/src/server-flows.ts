// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Wojciech Polak

import type { IncomingHttpHeaders } from 'node:http';
import { safeCompare } from '@magic-link-sso/config-core/runtime';
import { isVerifyEmailPreviewResponse, isVerifyEmailResponse } from '@magic-link-sso/core';
import { exchangeEmailOtp, getJwtSecret, verifyAuthToken } from '@magic-link-sso/angular';
import { buildFailureResult, readMessage } from 'magic-sso-example-ui/signin';
import { readServerUrlConfigError } from './signin-utils';

/**
 * Framework-free request flows behind the Express routes in `server.ts`, kept
 * here so they can be exercised without booting the Angular SSR engine.
 */

export interface SignInRequestBody {
    email?: string | undefined;
    returnUrl?: string | undefined;
    scope?: string | undefined;
    verifyUrl?: string | undefined;
}

export interface SignInResult {
    message: string;
    otpChallengeId?: string;
    otpLength?: number;
    success: boolean;
}

export interface VerifyOtpRequestBody {
    challengeId?: string | undefined;
    code?: string | undefined;
    returnUrl?: string | undefined;
}

export interface SignInResponse {
    result: SignInResult;
    status: number;
}

export type VerificationOutcome<T> = T | { error: string };

export interface VerificationPreview {
    email: string;
    token: string;
}

function isRecord(value: unknown): value is Record<string, unknown> {
    return typeof value === 'object' && value !== null;
}

export function readBodyString(value: unknown): string | undefined {
    return typeof value === 'string' && value.length > 0 ? value : undefined;
}

export function readSignInRequestBody(value: unknown): SignInRequestBody {
    const record = isRecord(value) ? value : {};

    return {
        email: readBodyString(record['email']),
        returnUrl: readBodyString(record['returnUrl']),
        scope: readBodyString(record['scope']),
        verifyUrl: readBodyString(record['verifyUrl']),
    };
}

export function readVerifyOtpRequestBody(value: unknown): VerifyOtpRequestBody {
    const record = isRecord(value) ? value : {};

    return {
        challengeId: readBodyString(record['challengeId']),
        code: readBodyString(record['code']),
        returnUrl: readBodyString(record['returnUrl']),
    };
}

function readUrlOrigin(value: string): string | null {
    try {
        return new URL(value).origin;
    } catch {
        return null;
    }
}

/** Accept a mutation only when its Origin (or, failing that, Referer) is this app. */
export function isSameOriginMutation(
    expectedOrigin: string,
    originHeader: string | undefined,
    refererHeader: string | undefined,
): boolean {
    if (readBodyString(originHeader) !== undefined) {
        return originHeader === expectedOrigin;
    }

    const referer = readBodyString(refererHeader);
    return typeof referer === 'string' && readUrlOrigin(referer) === expectedOrigin;
}

export function toWebHeaders(headers: IncomingHttpHeaders): Headers {
    const webHeaders = new Headers();
    for (const [name, value] of Object.entries(headers)) {
        for (const entry of [value].flat()) {
            if (typeof entry === 'string') {
                webHeaders.append(name, entry);
            }
        }
    }

    return webHeaders;
}

function failedSignIn(status: number, message: string): SignInResponse {
    return { result: { success: false, message }, status };
}

function readSignInConfigError(
    serverUrl: string | undefined,
    requestOrigin: string,
): string | null {
    return serverUrl
        ? readServerUrlConfigError(serverUrl, requestOrigin)
        : 'MAGICSSO_SERVER_URL is not configured.';
}

function readOtpMetadata(payload: unknown): Pick<SignInResult, 'otpChallengeId' | 'otpLength'> {
    const record = isRecord(payload) ? payload : {};
    const otpChallengeId = record['otpChallengeId'];
    const otpLength = record['otpLength'];
    return typeof otpChallengeId === 'string' && Number.isInteger(otpLength)
        ? { otpChallengeId, otpLength: Number(otpLength) }
        : {};
}

async function readResponsePayload(response: Response): Promise<unknown> {
    return response.json().catch(async () => ({
        message: await response.text().catch(() => ''),
    }));
}

async function postSignIn(
    body: Required<Pick<SignInRequestBody, 'email' | 'returnUrl' | 'verifyUrl'>> &
        Pick<SignInRequestBody, 'scope'>,
    serverUrl: string,
): Promise<SignInResponse> {
    const scope = body.scope?.trim();
    const ssoResponse = await fetch(new URL('/signin', serverUrl), {
        method: 'POST',
        headers: {
            'content-type': 'application/json',
        },
        body: JSON.stringify({
            email: body.email,
            returnUrl: body.returnUrl,
            verifyUrl: body.verifyUrl,
            ...(scope ? { scope } : {}),
        }),
        cache: 'no-store',
    });
    const payload = await readResponsePayload(ssoResponse);

    if (!ssoResponse.ok) {
        return failedSignIn(ssoResponse.status, buildFailureResult(payload).message);
    }

    return {
        result: { success: true, message: 'Verification email sent.', ...readOtpMetadata(payload) },
        status: 200,
    };
}

/** Forward a sign-in form submission to the Magic Link SSO server. */
export async function requestSignIn(
    body: SignInRequestBody,
    requestOrigin: string,
    serverUrl: string | undefined,
): Promise<SignInResponse> {
    const { email, returnUrl, scope, verifyUrl } = body;
    if (!email || !returnUrl || !verifyUrl) {
        return failedSignIn(400, 'Invalid sign-in request payload.');
    }

    const configError = readSignInConfigError(serverUrl, requestOrigin);
    if (typeof configError === 'string' || !serverUrl) {
        return failedSignIn(500, configError ?? 'MAGICSSO_SERVER_URL is not configured.');
    }

    try {
        return await postSignIn({ email, returnUrl, scope, verifyUrl }, serverUrl);
    } catch (error: unknown) {
        return failedSignIn(502, readMessage(error) ?? 'Failed to send verification email.');
    }
}

/** Exchange an emailed one-time code for an access token, or `null` when it is rejected. */
export async function exchangeOtpCode(
    body: VerifyOtpRequestBody,
    appOrigin: string,
    serverUrl: string | undefined,
): Promise<string | null> {
    const { challengeId, code } = body;
    if (!challengeId || !code || !serverUrl) {
        return null;
    }

    const result = await exchangeEmailOtp({ challengeId, code, expectedAudience: appOrigin });
    return result === null ? null : result.accessToken;
}

async function fetchVerificationPreview(
    serverUrl: string,
    token: string,
    previewSecret: string,
): Promise<VerificationOutcome<VerificationPreview>> {
    const previewUrl = new URL('/verify-email', serverUrl);
    previewUrl.searchParams.set('token', token);

    const verifyResponse = await fetch(previewUrl, {
        headers: {
            accept: 'application/json',
            'x-magic-sso-preview-secret': previewSecret,
        },
        cache: 'no-store',
    });
    const payload: unknown = verifyResponse.ok ? await verifyResponse.json() : null;
    return isVerifyEmailPreviewResponse(payload)
        ? { email: payload.email, token }
        : { error: 'verify-email-failed' };
}

/** Look up which email a magic-link token belongs to before asking the user to confirm. */
export async function previewVerificationToken(options: {
    previewSecret: string | undefined;
    serverUrl: string | undefined;
    token: string | undefined;
}): Promise<VerificationOutcome<VerificationPreview>> {
    const { previewSecret, serverUrl, token } = options;
    if (!token) {
        return { error: 'missing-verification-token' };
    }
    if (!serverUrl || !previewSecret) {
        return { error: 'verify-email-misconfigured' };
    }

    return fetchVerificationPreview(serverUrl, token, previewSecret).catch(() => ({
        error: 'verify-email-failed',
    }));
}

/** Prefer the posted token, but never one that disagrees with the token cookie. */
export function selectVerifyToken(
    submittedToken: string | undefined,
    cookieToken: string | undefined,
): string | undefined {
    if (typeof submittedToken !== 'string') {
        return cookieToken;
    }

    return cookieToken === undefined || submittedToken === cookieToken ? submittedToken : undefined;
}

export function hasValidCsrfPair(
    submittedToken: string | undefined,
    cookieToken: string | undefined,
): boolean {
    return (
        typeof submittedToken === 'string' &&
        typeof cookieToken === 'string' &&
        safeCompare(submittedToken, cookieToken)
    );
}

async function verifyReturnedAccessToken(
    accessToken: string,
    serverUrl: string,
    appOrigin: string,
): Promise<VerificationOutcome<{ accessToken: string }>> {
    const jwtSecret = getJwtSecret();
    if (jwtSecret === null) {
        return { error: 'session-verification-misconfigured' };
    }

    const auth = await verifyAuthToken(accessToken, jwtSecret, {
        expectedAudience: appOrigin,
        expectedIssuer: new URL(serverUrl).origin,
    });
    return auth === null ? { error: 'session-verification-failed' } : { accessToken };
}

async function postVerificationToken(
    serverUrl: string,
    token: string,
    appOrigin: string,
): Promise<VerificationOutcome<{ accessToken: string }>> {
    const verifyResponse = await fetch(new URL('/verify-email', serverUrl), {
        method: 'POST',
        headers: {
            accept: 'application/json',
            'content-type': 'application/json',
        },
        body: JSON.stringify({ token }),
        cache: 'no-store',
    });
    const payload: unknown = verifyResponse.ok ? await verifyResponse.json() : null;
    return isVerifyEmailResponse(payload)
        ? verifyReturnedAccessToken(payload.accessToken, serverUrl, appOrigin)
        : { error: 'verify-email-failed' };
}

/** Exchange a confirmed magic-link token for a verified access token. */
export async function exchangeVerificationToken(options: {
    appOrigin: string;
    serverUrl: string | undefined;
    token: string;
}): Promise<VerificationOutcome<{ accessToken: string }>> {
    if (!options.serverUrl) {
        return { error: 'verify-email-misconfigured' };
    }

    return postVerificationToken(options.serverUrl, options.token, options.appOrigin).catch(() => ({
        error: 'verify-email-failed',
    }));
}
