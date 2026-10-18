// SPDX-License-Identifier: MIT
import {
    MagicSsoConfigurationError,
    parseBrowserSsoLoginUi,
    type BrowserSsoMode,
} from '@magic-link-sso/core';

export const browserSsoPaths = {
    start: '/sso/start',
    callback: '/sso/callback',
    signedOut: '/sso/signed-out',
};

export function getBrowserSsoMode(): BrowserSsoMode {
    const mode = process.env.MAGICSSO_BROWSER_SSO_MODE?.trim() || 'off';
    if (mode !== 'off' && mode !== 'auto' && mode !== 'required') {
        throw new MagicSsoConfigurationError(
            'MAGICSSO_BROWSER_SSO_MODE must be off, auto or required.',
        );
    }
    return mode;
}

export function getBrowserSsoLoginUi(): 'hosted' | 'app-owned' {
    return parseBrowserSsoLoginUi(process.env.MAGICSSO_BROWSER_SSO_LOGIN_UI);
}
