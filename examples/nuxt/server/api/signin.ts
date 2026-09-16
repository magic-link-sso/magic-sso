// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Wojciech Polak

import {
    buildFailureResult,
    readMessage,
    readServerUrlConfigError as readSharedServerUrlConfigError,
} from 'magic-sso-example-ui/signin';

export function readServerUrlConfigError(serverUrl: string, requestOrigin: string): string | null {
    return readSharedServerUrlConfigError(serverUrl, requestOrigin, 'Nuxt');
}

export interface SignInRequestBody {
    email?: string;
    returnUrl?: string;
    scope?: string;
    verifyUrl?: string;
}

export type ValidSignInRequestBody = Required<
    Pick<SignInRequestBody, 'email' | 'returnUrl' | 'verifyUrl'>
> &
    Pick<SignInRequestBody, 'scope'>;

export interface SignInResult {
    success: boolean;
    message: string;
    otpChallengeId?: string;
    otpExpiresInSeconds?: number;
    otpLength?: number;
}

function readField(value: unknown, key: string): unknown {
    return typeof value === 'object' && value !== null ? Reflect.get(value, key) : undefined;
}

function isNonEmptyString(value: unknown): value is string {
    return typeof value === 'string' && value.length > 0;
}

function readOtpMetadata(
    value: unknown,
): Pick<SignInResult, 'otpChallengeId' | 'otpExpiresInSeconds' | 'otpLength'> {
    const challengeId = readField(value, 'otpChallengeId');
    const expiresInSeconds = readField(value, 'otpExpiresInSeconds');
    const length = readField(value, 'otpLength');
    return typeof challengeId === 'string' &&
        typeof expiresInSeconds === 'number' &&
        typeof length === 'number'
        ? {
              otpChallengeId: challengeId,
              otpExpiresInSeconds: expiresInSeconds,
              otpLength: length,
          }
        : {};
}

function getServerUrl(magicSsoConfig: unknown): string {
    const configuredServerUrl = readField(magicSsoConfig, 'serverUrl');
    if (isNonEmptyString(configuredServerUrl)) {
        return configuredServerUrl;
    }

    return process.env.MAGICSSO_SERVER_URL ?? process.env.APP_URL ?? '';
}

function readSignInConfigError(serverUrl: string, requestOrigin: string): string | null {
    return serverUrl.length === 0
        ? 'MAGICSSO_SERVER_URL is not configured.'
        : readServerUrlConfigError(serverUrl, requestOrigin);
}

async function readFailureMessage(response: Response): Promise<string> {
    const payload: unknown = await response.json().catch(async () => ({
        message: await response.text().catch(() => ''),
    }));
    return buildFailureResult(payload).message;
}

async function postSignIn(serverUrl: string, body: ValidSignInRequestBody): Promise<SignInResult> {
    const scope = body.scope?.trim();
    const response = await fetch(`${serverUrl}/signin`, {
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
    });

    if (!response.ok) {
        return { success: false, message: await readFailureMessage(response) };
    }

    const payload: unknown = await response.json().catch(() => null);
    return {
        success: true,
        message: 'Verification email sent.',
        ...readOtpMetadata(payload),
    };
}

/** Keep a sign-in submission only when it carries every required field. */
export function readValidSignInBody(
    body: SignInRequestBody | null | undefined,
): ValidSignInRequestBody | null {
    const { email, returnUrl, scope, verifyUrl } = body ?? {};
    return isNonEmptyString(email) && isNonEmptyString(returnUrl) && isNonEmptyString(verifyUrl)
        ? { email, returnUrl, scope, verifyUrl }
        : null;
}

/** Ask the Magic Link SSO server to send the sign-in email. */
export async function requestSignIn(
    body: ValidSignInRequestBody,
    magicSsoConfig: unknown,
    requestOrigin: string,
): Promise<SignInResult> {
    const serverUrl = getServerUrl(magicSsoConfig);
    const configError = readSignInConfigError(serverUrl, requestOrigin);
    if (typeof configError === 'string') {
        return { success: false, message: configError };
    }

    try {
        return await postSignIn(serverUrl, body);
    } catch (error: unknown) {
        return {
            success: false,
            message: readMessage(error) ?? 'Failed to send verification email.',
        };
    }
}
