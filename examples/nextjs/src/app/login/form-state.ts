// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Wojciech Polak

export type SearchParamValue = string | string[] | undefined;

export interface LoginFormState {
    emailDescribedBy: string;
    feedbackId: string | undefined;
    hasError: boolean;
    hasSuccess: boolean;
    verifyUrl: string;
}

/** Read the first value of a repeated search parameter. */
export function firstSearchParam(value: SearchParamValue): string | undefined {
    return Array.isArray(value) ? value[0] : value;
}

export function hasText(value: string | undefined): value is string {
    return typeof value === 'string' && value.length > 0;
}

/** Look up a message for a known status code carried in the login URL. */
export function lookupMessage(
    messages: Readonly<Record<string, string>>,
    code: string | undefined,
): string | undefined {
    return typeof code === 'string' ? messages[code] : undefined;
}

/** Derive the accessibility wiring and verify callback for the login form. */
export function buildLoginFormState(options: {
    appOrigin: string;
    initialError?: string | undefined;
    initialSuccess?: string | undefined;
    returnUrl: string;
}): LoginFormState {
    const hasError = hasText(options.initialError);
    const hasSuccess = hasText(options.initialSuccess);
    return {
        emailDescribedBy: hasError ? 'login-help login-feedback' : 'login-help',
        feedbackId: hasSuccess || hasError ? 'login-feedback' : undefined,
        hasError,
        hasSuccess,
        verifyUrl: `${options.appOrigin}/verify-email?returnUrl=${encodeURIComponent(options.returnUrl)}`,
    };
}
