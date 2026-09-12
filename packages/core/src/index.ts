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
