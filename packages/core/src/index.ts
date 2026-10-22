// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Wojciech Polak

export { buildAuthCookieOptions, readCookieValue } from './cookie.js';
export { MagicSsoConfigurationError } from './errors.js';
export { parseBooleanFlag } from './flags.js';
export { isVerifyEmailPreviewResponse, isVerifyEmailResponse } from './verify-email.js';
export { escapeHtml } from './html.js';
export { exchangeEmailOtp } from './otp.js';
export { buildLoginTarget, buildVerifyUrl, normaliseReturnUrl } from './return-url.js';
export { toSecretKey, verifyAuthToken, verifyAuthTokenWithOptionalIssuer } from './token.js';
export type {
    AuthCookieOptions,
    AuthPayload,
    BuildAuthCookieOptions,
    BuildLoginTargetOptions,
    EmailOtpExchangeAborted,
    EmailOtpExchangeNetworkError,
    EmailOtpExchangeRejected,
    EmailOtpExchangeResponseError,
    EmailOtpExchangeResult,
    EmailOtpExchangeSuccess,
    EmailOtpExchangeVerificationError,
    ExchangeEmailOtpOptions,
    NormaliseReturnUrlOptions,
    ReadCookieValueOptions,
    VerifyAuthTokenOptions,
    VerifyEmailPreviewResponse,
    VerifyEmailResponse,
    VerifyOptionalIssuerOptions,
} from './types.js';
export {
    BROWSER_SSO_VERSION,
    BROWSER_SSO_DEFAULTS,
    BROWSER_SSO_LIMITS,
    parseBrowserSsoCapabilities,
    parseBrowserSsoMode,
    parseBrowserSsoLoginUi,
} from './browser-sso.js';
export { createBrowserSsoHttpHandler, browserSsoPaths } from './browser-sso-http.js';
export type { BrowserSsoHttpOptions } from './browser-sso-http.js';
export {
    createBrowserSsoClient,
    parseBrowserSsoCookies,
    isBrowserSsoDocumentNavigation,
} from './browser-sso-client.js';
export type {
    BrowserSsoClient,
    BrowserSsoClientOptions,
    BrowserSsoCookie,
    BrowserSsoCookieValue,
    BrowserSsoStartResult,
    BrowserSsoCallbackResult,
    BrowserSsoClientFailure,
    BrowserSsoClientError,
} from './browser-sso-client.js';
export {
    createBrowserSsoRandomValue,
    createBrowserSsoCodeChallenge,
    sealBrowserSsoTransaction,
    unsealBrowserSsoTransaction,
} from './browser-sso-transaction.js';
export {
    getBrowserSsoErrorMessage,
    getBrowserSsoPageHeaders,
    renderBrowserSsoStatusPage,
} from './browser-sso-page.js';
export type {
    BrowserSsoTransactionPayload,
    BrowserSsoTransactionContext,
} from './browser-sso-transaction.js';
export type {
    BrowserSsoLifetimes,
    BrowserSsoMode,
    BrowserSsoLoginUi,
    BrowserSsoErrorCode,
    BrowserSsoAuthorizationRequest,
    BrowserSsoExchangeRequest,
    BrowserSsoCapabilities,
    BrowserSsoCapabilityResult,
} from './browser-sso.js';

export {
    hashBrowserSsoToken,
    createBrowserSsoBootstrapReceipt,
    verifyBrowserSsoBootstrapReceipt,
} from './browser-sso-bootstrap-receipt.js';
export type { BrowserSsoBootstrapReceiptContext } from './browser-sso-bootstrap-receipt.js';

export { createBrowserSsoBootstrapClient } from './browser-sso-bootstrap-client.js';
export type {
    BrowserSsoBootstrapContext,
    BrowserSsoPrepared,
    BrowserSsoBootstrapCompletion,
} from './browser-sso-bootstrap-client.js';
export {
    sealBrowserSsoContinuation,
    unsealBrowserSsoContinuation,
} from './browser-sso-continuation.js';
export type { BrowserSsoContinuation } from './browser-sso-continuation.js';
