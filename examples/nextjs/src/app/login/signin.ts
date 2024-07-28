// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Wojciech Polak

function readErrorMessage(data: unknown): string | undefined {
    if (
        typeof data === 'object' &&
        data !== null &&
        'message' in data &&
        typeof data.message === 'string' &&
        data.message.length > 0
    ) {
        return data.message;
    }

    return undefined;
}

async function readResponseMessage(response: Response): Promise<string | undefined> {
    const payload = (await response.json().catch(() => null)) as unknown;
    return readErrorMessage(payload);
}

export interface SignInResult {
    code?: string;
    message?: string;
    success: boolean;
}

export async function sendMagicLink(
    email: string,
    returnUrl: string,
    verifyUrl: string,
    scope?: string,
): Promise<SignInResult> {
    const serverUrl = process.env.MAGICSSO_SERVER_URL;
    if (typeof serverUrl !== 'string' || serverUrl.length === 0) {
        return {
            success: false,
            code: 'verify-email-misconfigured',
            message: 'MAGICSSO_SERVER_URL is not configured.',
        };
    }

    const normalizedScope = typeof scope === 'string' ? scope.trim() : '';

    try {
        const response = await fetch(new URL('/signin', serverUrl), {
            method: 'POST',
            headers: {
                'content-type': 'application/json',
            },
            body: JSON.stringify({
                email,
                returnUrl,
                verifyUrl,
                ...(normalizedScope.length > 0 ? { scope: normalizedScope } : {}),
            }),
            cache: 'no-store',
        });
        if (!response.ok) {
            const serverMessage = await readResponseMessage(response);
            console.error('Error sending magic link:', {
                serverMessage,
                status: response.status,
            });
            return {
                success: false,
                code: 'signin-request-failed',
                message: serverMessage ?? 'Failed to send verification email.',
            };
        }

        return { success: true };
    } catch (error: unknown) {
        if (error instanceof Error) {
            console.error('Error sending magic link:', { message: error.message });
        }
        return {
            success: false,
            code: 'signin-request-failed',
            message: 'Failed to send verification email.',
        };
    }
}
