// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Wojciech Polak

import {
    buildLoginTarget as buildCoreLoginTarget,
    buildVerifyUrl as buildCoreVerifyUrl,
    normaliseReturnUrl as normaliseCoreReturnUrl,
} from '@magic-link-sso/core';

export function normaliseReturnUrl(
    value: string | string[] | undefined,
    appOrigin: string,
): string {
    const returnUrl = Array.isArray(value) ? value[0] : value;
    const normalised = normaliseCoreReturnUrl({ appOrigin, fallback: appOrigin, returnUrl });
    // `normaliseCoreReturnUrl` canonicalises a bare-origin fallback to a trailing
    // slash; this app links back to the bare origin instead.
    return normalised === `${appOrigin}/` && returnUrl !== '/' ? appOrigin : normalised;
}

export function buildVerifyUrl(appOrigin: string, returnUrl: string): string {
    return buildCoreVerifyUrl(appOrigin, returnUrl);
}

export function buildLoginTarget(
    appOrigin: string,
    returnPath: string,
    directUse: boolean,
    serverUrl: string,
    scope?: string,
): string {
    return buildCoreLoginTarget({
        appOrigin,
        directUse,
        returnUrl: returnPath,
        ...(typeof scope === 'string' ? { scope } : {}),
        serverUrl,
    });
}
