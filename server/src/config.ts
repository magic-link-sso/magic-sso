/**
 * server/src/config.ts
 *
 * Magic Link SSO Copyright (C) 2026 Wojciech Polak
 *
 * This program is free software; you can redistribute it and/or modify it
 * under the terms of the GNU General Public License as published by the
 * Free Software Foundation; either version 3 of the License, or (at your
 * option) any later version.
 *
 * This program is distributed in the hope that it will be useful,
 * but WITHOUT ANY WARRANTY; without even the implied warranty of
 * MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE. See the
 * GNU General Public License for more details.
 *
 * You should have received a copy of the GNU General Public License along
 * with this program. If not, see <https://www.gnu.org/licenses/>.
 */

import { readFileSync } from 'node:fs';
import { parse as parseToml } from 'smol-toml';
import { z } from 'zod';
import { FULL_ACCESS_SCOPE } from './scope.js';

export interface SmtpTransportConfig {
    host: string;
    pass: string;
    port: number;
    secure: boolean;
    user: string;
}

export interface HostedAuthSigninCopy {
    confirmationHelpText: string;
    confirmationPageTitle: string;
    confirmationTitle: string;
    emailLabel: string;
    emailPlaceholder: string;
    helpText: string;
    pageTitle: string;
    skipLink: string;
    submitButton: string;
    title: string;
    useDifferentEmailButton: string;
}

export interface HostedAuthVerifyEmailCopy {
    continueButton: string;
    emailLabel: string;
    helpText: string;
    pageTitle: string;
    title: string;
}

export interface HostedAuthFeedbackCopy {
    failedToSendEmail: string;
    forbidden: string;
    invalidOrExpiredToken: string;
    invalidOrUntrustedReturnUrl: string;
    invalidOrUntrustedVerifyUrl: string;
    invalidRequest: string;
    tooManyRequests: string;
    verificationEmailSent: string;
}

export interface HostedAuthPageCopy {
    feedback: HostedAuthFeedbackCopy;
    lang: string;
    signin: HostedAuthSigninCopy;
    verifyEmail: HostedAuthVerifyEmailCopy;
}

export interface HostedAuthSigninCssVariables {
    '--color-background'?: string | undefined;
    '--color-border'?: string | undefined;
    '--color-border-soft'?: string | undefined;
    '--color-button-background'?: string | undefined;
    '--color-button-background-hover'?: string | undefined;
    '--color-button-text'?: string | undefined;
    '--color-error-background'?: string | undefined;
    '--color-error-text'?: string | undefined;
    '--color-field-background'?: string | undefined;
    '--color-focus'?: string | undefined;
    '--color-muted'?: string | undefined;
    '--color-surface'?: string | undefined;
    '--color-success-background'?: string | undefined;
    '--color-success-text'?: string | undefined;
    '--color-text'?: string | undefined;
    '--shadow-panel'?: string | undefined;
}

export interface HostedAuthVerifyEmailCssVariables {
    '--color-background'?: string | undefined;
    '--color-border'?: string | undefined;
    '--color-button-background'?: string | undefined;
    '--color-button-text'?: string | undefined;
    '--color-card-background'?: string | undefined;
    '--color-card-shadow'?: string | undefined;
    '--color-error-background'?: string | undefined;
    '--color-error-text'?: string | undefined;
    '--color-text'?: string | undefined;
}

export interface HostedAuthBranding {
    logoAlt: string;
    logoImageUrl: string | undefined;
    logoText: string;
    signinCssVariables: HostedAuthSigninCssVariables;
    supportLinkText: string | undefined;
    supportLinkUrl: string | undefined;
    supportText: string;
    title: string;
    verifyEmailCssVariables: HostedAuthVerifyEmailCssVariables;
}

export interface HostedAuthConfig {
    hostedAuthBranding: HostedAuthBranding;
    hostedAuthPageCopy: HostedAuthPageCopy;
}

export type SiteAccessRules = Map<string, Set<string>>;

export interface RedirectUriRule {
    match: 'exact' | 'subpath';
    origin: string;
    pathname: string;
}

export interface SiteConfig extends HostedAuthConfig {
    accessRules: SiteAccessRules;
    allowedRedirectUris: RedirectUriRule[];
    id: string;
    origins: Set<string>;
}

export interface SecurityStateConfig {
    adapter: 'file' | 'redis';
    keyPrefix: string;
    redisUrl: string | undefined;
}

export interface AppConfig extends HostedAuthConfig {
    appPort: number;
    appUrl: string;
    csrfSecret: string;
    cookieDomain: string | undefined;
    cookieHttpOnly: boolean;
    cookieName: string;
    cookiePath: string | undefined;
    cookieSameSite: 'lax' | 'strict' | 'none';
    cookieSecure: boolean;
    emailExpirationSeconds: number;
    emailFrom: string;
    emailSecret: string;
    emailSignature: string;
    emailSmtpFallbacks: SmtpTransportConfig[];
    emailSmtpHost: string;
    emailSmtpPass: string;
    emailSmtpPort: number;
    emailSmtpSecure: boolean;
    emailSmtpUser: string;
    jwtExpirationSeconds: number;
    jwtSecret: string;
    previewSecret: string;
    healthzRateLimitMax: number;
    logFormat: 'json' | 'pretty';
    logLevel: 'trace' | 'debug' | 'info' | 'warn' | 'error' | 'fatal';
    rateLimitWindowMs: number;
    securityState: SecurityStateConfig;
    serveRootLandingPage: boolean;
    signInEmailRateLimitMax: number;
    signInEmailRateLimitStoreDir: string;
    signInPageRateLimitMax: number;
    signInRateLimitMax: number;
    sites: SiteConfig[];
    trustProxy: boolean | number;
    verifyRateLimitMax: number;
    verifyTokenStoreDir: string;
}

const MIN_SECRET_LENGTH = 32;

function configuredSecretSchema(fieldName: string): z.ZodString {
    return z
        .string()
        .min(
            MIN_SECRET_LENGTH,
            `${fieldName} must be at least ${MIN_SECRET_LENGTH} characters long.`,
        );
}

const smtpTransportConfigSchema = z
    .object({
        host: z.string().min(1),
        pass: z.string().min(1),
        port: z.number().int().positive().default(587),
        secure: z.boolean().default(false),
        user: z.string().min(1),
    })
    .strict();

const hostedAuthSigninCopyOverrideSchema = z
    .object({
        confirmationHelpText: z.string().min(1).optional(),
        confirmationPageTitle: z.string().min(1).optional(),
        confirmationTitle: z.string().min(1).optional(),
        emailLabel: z.string().min(1).optional(),
        emailPlaceholder: z.string().min(1).optional(),
        helpText: z.string().min(1).optional(),
        pageTitle: z.string().min(1).optional(),
        skipLink: z.string().min(1).optional(),
        submitButton: z.string().min(1).optional(),
        title: z.string().min(1).optional(),
        useDifferentEmailButton: z.string().min(1).optional(),
    })
    .strict();

const hostedAuthVerifyEmailCopyOverrideSchema = z
    .object({
        continueButton: z.string().min(1).optional(),
        emailLabel: z.string().min(1).optional(),
        helpText: z.string().min(1).optional(),
        pageTitle: z.string().min(1).optional(),
        title: z.string().min(1).optional(),
    })
    .strict();

const hostedAuthFeedbackCopyOverrideSchema = z
    .object({
        failedToSendEmail: z.string().min(1).optional(),
        forbidden: z.string().min(1).optional(),
        invalidOrExpiredToken: z.string().min(1).optional(),
        invalidOrUntrustedReturnUrl: z.string().min(1).optional(),
        invalidOrUntrustedVerifyUrl: z.string().min(1).optional(),
        invalidRequest: z.string().min(1).optional(),
        tooManyRequests: z.string().min(1).optional(),
        verificationEmailSent: z.string().min(1).optional(),
    })
    .strict();

const hostedAuthPageCopyOverrideSchema = z
    .object({
        feedback: hostedAuthFeedbackCopyOverrideSchema.optional(),
        lang: z.string().min(1).optional(),
        signin: hostedAuthSigninCopyOverrideSchema.optional(),
        verifyEmail: hostedAuthVerifyEmailCopyOverrideSchema.optional(),
    })
    .strict();

const unsafeCssVariableValuePattern = /[{};<>"'\\\u2028\u2029]/u;

function hasControlCharacters(value: string): boolean {
    for (const character of value) {
        const codePoint = character.codePointAt(0);
        if (typeof codePoint === 'number' && (codePoint <= 0x1f || codePoint === 0x7f)) {
            return true;
        }
    }

    return false;
}

function isSafeCssVariableValue(value: string): boolean {
    return (
        value.trim().length > 0 &&
        !hasControlCharacters(value) &&
        !unsafeCssVariableValuePattern.test(value) &&
        !/url\s*\(/iu.test(value)
    );
}

const safeCssVariableValueSchema = z.string().min(1).refine(isSafeCssVariableValue, {
    message:
        'CSS variable values must not include declarations, blocks, escapes, control characters, quotes, or URLs.',
});

const hostedAuthSigninCssVariablesOverrideSchema = z
    .object({
        '--color-background': safeCssVariableValueSchema.optional(),
        '--color-border': safeCssVariableValueSchema.optional(),
        '--color-border-soft': safeCssVariableValueSchema.optional(),
        '--color-button-background': safeCssVariableValueSchema.optional(),
        '--color-button-background-hover': safeCssVariableValueSchema.optional(),
        '--color-button-text': safeCssVariableValueSchema.optional(),
        '--color-error-background': safeCssVariableValueSchema.optional(),
        '--color-error-text': safeCssVariableValueSchema.optional(),
        '--color-field-background': safeCssVariableValueSchema.optional(),
        '--color-focus': safeCssVariableValueSchema.optional(),
        '--color-muted': safeCssVariableValueSchema.optional(),
        '--color-surface': safeCssVariableValueSchema.optional(),
        '--color-success-background': safeCssVariableValueSchema.optional(),
        '--color-success-text': safeCssVariableValueSchema.optional(),
        '--color-text': safeCssVariableValueSchema.optional(),
        '--shadow-panel': safeCssVariableValueSchema.optional(),
    })
    .strict();

const hostedAuthVerifyEmailCssVariablesOverrideSchema = z
    .object({
        '--color-background': safeCssVariableValueSchema.optional(),
        '--color-border': safeCssVariableValueSchema.optional(),
        '--color-button-background': safeCssVariableValueSchema.optional(),
        '--color-button-text': safeCssVariableValueSchema.optional(),
        '--color-card-background': safeCssVariableValueSchema.optional(),
        '--color-card-shadow': safeCssVariableValueSchema.optional(),
        '--color-error-background': safeCssVariableValueSchema.optional(),
        '--color-error-text': safeCssVariableValueSchema.optional(),
        '--color-text': safeCssVariableValueSchema.optional(),
    })
    .strict();

const hostedAuthBrandingOverrideSchema = z
    .object({
        logoAlt: z.string().min(1).optional(),
        logoImageUrl: z.string().min(1).optional(),
        logoText: z.string().min(1).optional(),
        signinCssVariables: hostedAuthSigninCssVariablesOverrideSchema.optional(),
        supportLinkText: z.string().min(1).optional(),
        supportLinkUrl: z.string().min(1).optional(),
        supportText: z.string().min(1).optional(),
        title: z.string().min(1).optional(),
        verifyEmailCssVariables: hostedAuthVerifyEmailCssVariablesOverrideSchema.optional(),
    })
    .strict()
    .superRefine((value, context) => {
        if (
            (typeof value.supportLinkText === 'string') !==
            (typeof value.supportLinkUrl === 'string')
        ) {
            context.addIssue({
                code: z.ZodIssueCode.custom,
                message: 'supportLinkText and supportLinkUrl must be configured together.',
            });
        }
    });

const rawHostedAuthSchema = z
    .object({
        branding: hostedAuthBrandingOverrideSchema.optional(),
        copy: hostedAuthPageCopyOverrideSchema.optional(),
    })
    .strict();

const rawSiteAccessRuleSchema = z
    .object({
        email: z.string().min(1),
        scopes: z.array(z.string()).min(1),
    })
    .strict();

const rawSiteSchema = z
    .object({
        accessRules: z.array(rawSiteAccessRuleSchema).default([]),
        allowedRedirectUris: z.array(z.string()).min(1),
        allowedEmails: z.array(z.string()).default([]),
        hostedAuth: rawHostedAuthSchema.optional(),
        id: z.string().min(1),
        origins: z.array(z.string()).min(1),
    })
    .strict()
    .superRefine((value, context) => {
        if (value.allowedEmails.length === 0 && value.accessRules.length === 0) {
            context.addIssue({
                code: z.ZodIssueCode.custom,
                message: 'Each site must define allowedEmails, accessRules, or both.',
            });
        }
    });

const rawConfigSchema = z
    .object({
        auth: z
            .object({
                csrfSecret: configuredSecretSchema('auth.csrfSecret'),
                emailExpiration: z.union([z.number().positive(), z.string().min(1)]).default('15m'),
                emailSecret: configuredSecretSchema('auth.emailSecret'),
                jwtExpiration: z.union([z.number().positive(), z.string().min(1)]).default('1h'),
                jwtSecret: configuredSecretSchema('auth.jwtSecret'),
                previewSecret: configuredSecretSchema('auth.previewSecret'),
            })
            .strict(),
        cookie: z
            .object({
                domain: z.string().min(1).optional(),
                httpOnly: z.boolean().optional(),
                name: z.string().min(1).optional(),
                path: z.string().min(1).optional(),
                sameSite: z.enum(['lax', 'strict', 'none']).optional(),
                secure: z.boolean().optional(),
            })
            .strict()
            .optional(),
        email: z
            .object({
                from: z.string().email(),
                signature: z.string().default(''),
                smtp: smtpTransportConfigSchema,
                smtpFallbacks: z.array(smtpTransportConfigSchema).default([]),
            })
            .strict(),
        hostedAuth: rawHostedAuthSchema.default({}),
        rateLimit: z
            .object({
                healthzMax: z.number().int().positive().optional(),
                signInEmailMax: z.number().int().positive().optional(),
                signInMax: z.number().int().positive().optional(),
                signInPageMax: z.number().int().positive().optional(),
                verifyMax: z.number().int().positive().optional(),
                windowMs: z.number().int().positive().optional(),
            })
            .strict()
            .optional(),
        server: z
            .object({
                appPort: z.number().int().positive().optional(),
                appUrl: z.string().url().optional(),
                logFormat: z.enum(['json', 'pretty']).optional(),
                logLevel: z.enum(['trace', 'debug', 'info', 'warn', 'error', 'fatal']).optional(),
                securityState: z
                    .object({
                        adapter: z.enum(['file', 'redis']).optional(),
                        keyPrefix: z.string().min(1).optional(),
                        redisUrl: z.string().url().optional(),
                    })
                    .strict()
                    .optional(),
                serveRootLandingPage: z.boolean().optional(),
                signInEmailRateLimitStoreDir: z.string().min(1).optional(),
                trustProxy: z.union([z.boolean(), z.number().int().nonnegative()]).optional(),
                verifyTokenStoreDir: z.string().min(1).optional(),
            })
            .strict()
            .optional(),
        sites: z.array(rawSiteSchema).min(1),
    })
    .strict();

export function createDefaultHostedAuthPageCopy(): HostedAuthPageCopy {
    return {
        lang: 'en',
        signin: {
            confirmationHelpText:
                'If your email can sign in, you will receive a link shortly. Open the email and click the link to continue.',
            confirmationPageTitle: 'Check Your Email',
            confirmationTitle: 'Check your email',
            pageTitle: 'Sign In',
            title: 'Sign in',
            helpText: "We'll email you a sign-in link.",
            emailLabel: 'Email',
            emailPlaceholder: 'you@example.com',
            submitButton: 'Send magic link',
            skipLink: 'Skip to sign-in form',
            useDifferentEmailButton: 'Use a different email',
        },
        verifyEmail: {
            pageTitle: 'Verify Email',
            title: 'Magic Link SSO',
            helpText: 'Review the email address below, then continue to finish signing in.',
            continueButton: 'Continue',
            emailLabel: 'Email',
        },
        feedback: {
            invalidRequest: 'Invalid request',
            invalidOrUntrustedReturnUrl: 'Invalid or untrusted return URL',
            invalidOrUntrustedVerifyUrl: 'Invalid or untrusted verify URL',
            forbidden: 'Forbidden',
            failedToSendEmail: 'Failed to send email',
            tooManyRequests: 'Too many requests',
            verificationEmailSent: 'Verification email sent',
            invalidOrExpiredToken: 'Invalid or expired token',
        },
    };
}

export function createDefaultHostedAuthBranding(): HostedAuthBranding {
    return {
        title: 'Magic Link SSO',
        logoText: 'KEY',
        logoAlt: 'Magic Link SSO',
        logoImageUrl: undefined,
        supportText: '',
        supportLinkText: undefined,
        supportLinkUrl: undefined,
        signinCssVariables: {},
        verifyEmailCssVariables: {},
    };
}

function parseCookieSecure(value: boolean | undefined, appUrl: URL): boolean {
    const defaultSecure = appUrl.protocol === 'https:';
    const cookieSecure = value ?? defaultSecure;

    if (appUrl.protocol === 'https:' && !cookieSecure) {
        throw new Error(
            'cookie.secure must be true when server.appUrl uses HTTPS to avoid issuing auth cookies without the Secure flag.',
        );
    }

    return cookieSecure;
}

function parseCookieHttpOnly(value: boolean | undefined): true {
    if (value === false) {
        throw new Error(
            'cookie.httpOnly must remain true because Magic Link SSO session cookies contain bearer JWTs.',
        );
    }

    return true;
}

function parseCookieSameSite(
    value: 'lax' | 'strict' | 'none' | undefined,
    appUrl: URL,
): 'lax' | 'strict' | 'none' {
    const cookieSameSite = value ?? 'lax';

    if (cookieSameSite === 'none' && appUrl.protocol !== 'https:') {
        throw new Error(
            'cookie.sameSite = "none" requires server.appUrl to use HTTPS so browsers will accept the cookie.',
        );
    }

    return cookieSameSite;
}

function parseRedisUrl(value: string, fieldName: string): string {
    let parsedUrl: URL;
    try {
        parsedUrl = new URL(value);
    } catch {
        throw new Error(`${fieldName} must be a valid redis:// or rediss:// URL.`);
    }

    if (parsedUrl.protocol !== 'redis:' && parsedUrl.protocol !== 'rediss:') {
        throw new Error(`${fieldName} must use the redis:// or rediss:// protocol.`);
    }

    return value;
}

const placeholderSecretsByField = new Map<string, Set<string>>([
    ['auth.jwtSecret', new Set(['your_jwt_secret', 'replace-me-with-a-long-random-jwt-secret'])],
    ['auth.emailSecret', new Set(['replace-me-with-a-different-long-random-email-secret'])],
    ['auth.csrfSecret', new Set(['replace-me-with-a-different-long-random-csrf-secret'])],
    ['auth.previewSecret', new Set(['replace-me-with-a-different-long-random-preview-secret'])],
]);

function parseConfiguredSecret(value: string, fieldName: string): string {
    const trimmedValue = value.trim();
    if (trimmedValue.length < MIN_SECRET_LENGTH) {
        throw new Error(`${fieldName} must be at least ${MIN_SECRET_LENGTH} characters long.`);
    }

    const placeholderValues = placeholderSecretsByField.get(fieldName);
    if (placeholderValues?.has(trimmedValue)) {
        throw new Error(`${fieldName} must be replaced with a real secret value.`);
    }

    return value;
}

function validateDistinctSecrets(
    jwtSecret: string,
    emailSecret: string,
    csrfSecret: string,
    previewSecret: string,
): void {
    if (csrfSecret === jwtSecret) {
        throw new Error('auth.csrfSecret must differ from auth.jwtSecret.');
    }
    if (emailSecret === jwtSecret) {
        throw new Error('auth.emailSecret must differ from auth.jwtSecret.');
    }
    if (emailSecret === csrfSecret) {
        throw new Error('auth.emailSecret must differ from auth.csrfSecret.');
    }
    if (previewSecret === jwtSecret) {
        throw new Error('auth.previewSecret must differ from auth.jwtSecret.');
    }
    if (previewSecret === emailSecret) {
        throw new Error('auth.previewSecret must differ from auth.emailSecret.');
    }
    if (previewSecret === csrfSecret) {
        throw new Error('auth.previewSecret must differ from auth.csrfSecret.');
    }
}

function isLocalHttpUrl(url: URL): boolean {
    return url.protocol === 'http:' && url.hostname === 'localhost';
}

function parseDurationToSeconds(value: number | string): number {
    if (typeof value === 'number') {
        if (!Number.isFinite(value) || value <= 0) {
            throw new Error(`Invalid duration value: ${value}`);
        }

        return value;
    }

    const trimmed = value.trim().toLowerCase();
    const numericValue = Number(trimmed);
    if (Number.isFinite(numericValue) && numericValue > 0) {
        return numericValue;
    }

    const match = trimmed.match(/^(\d+)([smhd])$/u);
    if (!match) {
        throw new Error(`Invalid duration value: ${value}`);
    }

    const amountText = match[1];
    const unit = match[2];
    if (typeof amountText !== 'string' || typeof unit !== 'string') {
        throw new Error(`Invalid duration value: ${value}`);
    }

    const amount = Number.parseInt(amountText, 10);
    if (unit === 's') {
        return amount;
    }
    if (unit === 'm') {
        return amount * 60;
    }
    if (unit === 'h') {
        return amount * 60 * 60;
    }

    return amount * 60 * 60 * 24;
}

function normaliseAllowedEmails(emails: string[], sourceName: string): string[] {
    const emailSchema = z.string().trim().toLowerCase().email();
    const normalisedEmails = emails
        .map((email) => email.trim())
        .filter((email) => email.length > 0)
        .map((email) => emailSchema.parse(email));

    if (normalisedEmails.length === 0) {
        throw new Error(`${sourceName} must contain at least one email address.`);
    }

    return normalisedEmails;
}

function normaliseScopes(scopes: string[], sourceName: string): string[] {
    const normalisedScopes = scopes
        .map((scope) => scope.trim())
        .filter((scope) => scope.length > 0);

    if (normalisedScopes.length === 0) {
        throw new Error(`${sourceName} must contain at least one scope.`);
    }

    return normalisedScopes;
}

function addAccessRule(
    accessRules: SiteAccessRules,
    email: string,
    scopes: Iterable<string>,
): void {
    const existingScopes = accessRules.get(email) ?? new Set<string>();
    for (const scope of scopes) {
        existingScopes.add(scope);
    }
    accessRules.set(email, existingScopes);
}

function buildSiteAccessRules(site: z.infer<typeof rawSiteSchema>): SiteAccessRules {
    const accessRules: SiteAccessRules = new Map();

    if (site.allowedEmails.length > 0) {
        for (const email of normaliseAllowedEmails(
            site.allowedEmails,
            `sites[${site.id}].allowedEmails`,
        )) {
            addAccessRule(accessRules, email, [FULL_ACCESS_SCOPE]);
        }
    }

    for (const [index, accessRule] of site.accessRules.entries()) {
        const [email] = normaliseAllowedEmails(
            [accessRule.email],
            `sites[${site.id}].accessRules[${index}].email`,
        );
        const scopes = normaliseScopes(
            accessRule.scopes,
            `sites[${site.id}].accessRules[${index}].scopes`,
        );
        if (typeof email === 'undefined') {
            throw new Error(`sites[${site.id}].accessRules[${index}].email must be configured.`);
        }
        addAccessRule(accessRules, email, scopes);
    }

    return accessRules;
}

function parseOrigin(value: string, sourceName: string): string {
    let parsedUrl: URL;
    try {
        parsedUrl = new URL(value);
    } catch {
        throw new Error(`${sourceName} must contain only absolute http(s) origins.`);
    }

    if (parsedUrl.protocol !== 'http:' && parsedUrl.protocol !== 'https:') {
        throw new Error(`${sourceName} must contain only absolute http(s) origins.`);
    }

    return parsedUrl.origin;
}

function extractRawPathComponent(value: string): string | null {
    if (value.startsWith('/')) {
        return value.split(/[?#]/, 1)[0] ?? null;
    }

    const match = value.match(/^[a-zA-Z][a-zA-Z0-9+.-]*:\/\/[^/?#]*/u);
    if (typeof match?.[0] !== 'string') {
        return null;
    }

    return value.slice(match[0].length).split(/[?#]/, 1)[0] ?? null;
}

export function hasSuspiciousRedirectPath(value: string): boolean {
    const rawPath = extractRawPathComponent(value);
    if (rawPath === null) {
        return false;
    }

    const lowerPath = rawPath.toLowerCase();
    return (
        lowerPath.includes('%2e') ||
        lowerPath.includes('%2f') ||
        lowerPath.includes('%5c') ||
        /(?:^|\/)\.\.(?:\/|$)/u.test(rawPath)
    );
}

function parseOrigins(values: string[], sourceName: string): Set<string> {
    const origins = values
        .map((origin) => origin.trim())
        .filter((origin) => origin.length > 0)
        .map((origin) => parseOrigin(origin, sourceName));

    if (origins.length === 0) {
        throw new Error(`${sourceName} must contain at least one origin.`);
    }

    return new Set(origins);
}

function parseAllowedRedirectUriRule(value: string, sourceName: string): RedirectUriRule {
    const trimmedValue = value.trim();
    if (trimmedValue.length === 0) {
        throw new Error(`${sourceName} must contain at least one redirect URI.`);
    }

    const isSubpathRule = trimmedValue.endsWith('/*');
    const parseTarget = isSubpathRule ? trimmedValue.slice(0, -1) : trimmedValue;

    let parsedUrl: URL;
    try {
        parsedUrl = new URL(parseTarget);
    } catch {
        throw new Error(
            `${sourceName} must contain only absolute http(s) URLs and may optionally end with /* for strict sub-path matches.`,
        );
    }

    if (parsedUrl.protocol !== 'http:' && parsedUrl.protocol !== 'https:') {
        throw new Error(
            `${sourceName} must contain only absolute http(s) URLs and may optionally end with /* for strict sub-path matches.`,
        );
    }

    if (parsedUrl.search !== '' || parsedUrl.hash !== '') {
        throw new Error(
            `${sourceName} must not include query strings or hash fragments; configure only the trusted origin and path.`,
        );
    }

    if (hasSuspiciousRedirectPath(trimmedValue)) {
        throw new Error(
            `${sourceName} must not contain encoded path traversal sequences or dot segments.`,
        );
    }

    return {
        match: isSubpathRule ? 'subpath' : 'exact',
        origin: parsedUrl.origin,
        pathname: parsedUrl.pathname,
    };
}

function parseAllowedRedirectUris(values: string[], sourceName: string): RedirectUriRule[] {
    const allowedRedirectUris = values
        .map((value) => value.trim())
        .filter((value) => value.length > 0)
        .map((value) => parseAllowedRedirectUriRule(value, sourceName));

    if (allowedRedirectUris.length === 0) {
        throw new Error(`${sourceName} must contain at least one redirect URI.`);
    }

    return allowedRedirectUris;
}

function parseHostedAuthPathOrUrl(
    value: string | undefined,
    fieldName: string,
    options: {
        allowMailto: boolean;
    },
): string | undefined {
    if (typeof value === 'undefined') {
        return undefined;
    }

    if (value.startsWith('/') && !value.startsWith('//')) {
        return value;
    }

    let parsedUrl: URL;
    try {
        parsedUrl = new URL(value);
    } catch {
        throw new Error(
            `${fieldName} must be an absolute http(s) URL, a site-relative path,${options.allowMailto ? ' or a mailto link.' : ' and not an invalid URL.'}`,
        );
    }

    const isHttpUrl = parsedUrl.protocol === 'http:' || parsedUrl.protocol === 'https:';
    if (isHttpUrl) {
        return value;
    }
    if (options.allowMailto && parsedUrl.protocol === 'mailto:') {
        return value;
    }

    throw new Error(
        `${fieldName} must be an absolute http(s) URL, a site-relative path,${options.allowMailto ? ' or a mailto link.' : ' and not an unsupported protocol.'}`,
    );
}

function resolveHostedAuthPageCopy(
    value: unknown,
    defaults: HostedAuthPageCopy,
    fieldName: string,
): HostedAuthPageCopy {
    if (typeof value === 'undefined') {
        return defaults;
    }

    const parsedCopy = hostedAuthPageCopyOverrideSchema.safeParse(value);
    if (!parsedCopy.success) {
        throw new Error(`${fieldName} must be a TOML table with hosted auth text overrides.`);
    }

    return {
        lang: parsedCopy.data.lang ?? defaults.lang,
        signin: {
            confirmationHelpText:
                parsedCopy.data.signin?.confirmationHelpText ??
                defaults.signin.confirmationHelpText,
            confirmationPageTitle:
                parsedCopy.data.signin?.confirmationPageTitle ??
                defaults.signin.confirmationPageTitle,
            confirmationTitle:
                parsedCopy.data.signin?.confirmationTitle ?? defaults.signin.confirmationTitle,
            emailLabel: parsedCopy.data.signin?.emailLabel ?? defaults.signin.emailLabel,
            emailPlaceholder:
                parsedCopy.data.signin?.emailPlaceholder ?? defaults.signin.emailPlaceholder,
            helpText: parsedCopy.data.signin?.helpText ?? defaults.signin.helpText,
            pageTitle: parsedCopy.data.signin?.pageTitle ?? defaults.signin.pageTitle,
            skipLink: parsedCopy.data.signin?.skipLink ?? defaults.signin.skipLink,
            submitButton: parsedCopy.data.signin?.submitButton ?? defaults.signin.submitButton,
            title: parsedCopy.data.signin?.title ?? defaults.signin.title,
            useDifferentEmailButton:
                parsedCopy.data.signin?.useDifferentEmailButton ??
                defaults.signin.useDifferentEmailButton,
        },
        verifyEmail: {
            continueButton:
                parsedCopy.data.verifyEmail?.continueButton ?? defaults.verifyEmail.continueButton,
            emailLabel: parsedCopy.data.verifyEmail?.emailLabel ?? defaults.verifyEmail.emailLabel,
            helpText: parsedCopy.data.verifyEmail?.helpText ?? defaults.verifyEmail.helpText,
            pageTitle: parsedCopy.data.verifyEmail?.pageTitle ?? defaults.verifyEmail.pageTitle,
            title: parsedCopy.data.verifyEmail?.title ?? defaults.verifyEmail.title,
        },
        feedback: {
            failedToSendEmail:
                parsedCopy.data.feedback?.failedToSendEmail ?? defaults.feedback.failedToSendEmail,
            forbidden: parsedCopy.data.feedback?.forbidden ?? defaults.feedback.forbidden,
            invalidOrExpiredToken:
                parsedCopy.data.feedback?.invalidOrExpiredToken ??
                defaults.feedback.invalidOrExpiredToken,
            invalidOrUntrustedReturnUrl:
                parsedCopy.data.feedback?.invalidOrUntrustedReturnUrl ??
                defaults.feedback.invalidOrUntrustedReturnUrl,
            invalidOrUntrustedVerifyUrl:
                parsedCopy.data.feedback?.invalidOrUntrustedVerifyUrl ??
                defaults.feedback.invalidOrUntrustedVerifyUrl,
            invalidRequest:
                parsedCopy.data.feedback?.invalidRequest ?? defaults.feedback.invalidRequest,
            tooManyRequests:
                parsedCopy.data.feedback?.tooManyRequests ?? defaults.feedback.tooManyRequests,
            verificationEmailSent:
                parsedCopy.data.feedback?.verificationEmailSent ??
                defaults.feedback.verificationEmailSent,
        },
    };
}

function resolveHostedAuthBranding(
    value: unknown,
    defaults: HostedAuthBranding,
    fieldName: string,
): HostedAuthBranding {
    if (typeof value === 'undefined') {
        return defaults;
    }

    const parsedBranding = hostedAuthBrandingOverrideSchema.safeParse(value);
    if (!parsedBranding.success) {
        throw new Error(`${fieldName} must be a TOML table with hosted auth branding overrides.`);
    }

    return {
        title: parsedBranding.data.title ?? defaults.title,
        logoAlt: parsedBranding.data.logoAlt ?? defaults.logoAlt,
        logoImageUrl: parseHostedAuthPathOrUrl(
            parsedBranding.data.logoImageUrl,
            `${fieldName}.logoImageUrl`,
            {
                allowMailto: false,
            },
        ),
        logoText: parsedBranding.data.logoText ?? defaults.logoText,
        supportText: parsedBranding.data.supportText ?? defaults.supportText,
        supportLinkText: parsedBranding.data.supportLinkText ?? defaults.supportLinkText,
        supportLinkUrl: parseHostedAuthPathOrUrl(
            parsedBranding.data.supportLinkUrl,
            `${fieldName}.supportLinkUrl`,
            {
                allowMailto: true,
            },
        ),
        signinCssVariables: {
            ...defaults.signinCssVariables,
            ...parsedBranding.data.signinCssVariables,
        },
        verifyEmailCssVariables: {
            ...defaults.verifyEmailCssVariables,
            ...parsedBranding.data.verifyEmailCssVariables,
        },
    };
}

function parseConfigToml(fileContents: string, filePath: string): AppConfig {
    let parsedToml: unknown;
    try {
        parsedToml = parseToml(fileContents);
    } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        throw new Error(`Failed to parse MAGICSSO_CONFIG_FILE (${filePath}): ${message}`);
    }

    const parsedConfig = rawConfigSchema.safeParse(parsedToml);
    if (!parsedConfig.success) {
        const issue = parsedConfig.error.issues[0];
        const issuePath =
            typeof issue !== 'undefined' && issue.path.length > 0
                ? `${issue.path.map(String).join('.')}: `
                : '';
        const issueMessage = typeof issue !== 'undefined' ? issue.message : 'Invalid config.';
        throw new Error(
            `Failed to validate MAGICSSO_CONFIG_FILE (${filePath}): ${issuePath}${issueMessage}`,
        );
    }

    const serverConfig = parsedConfig.data.server ?? {};
    const cookieConfig = parsedConfig.data.cookie ?? {};
    const rateLimitConfig = parsedConfig.data.rateLimit ?? {};
    const securityStateConfig = serverConfig.securityState ?? {};
    const appUrl = new URL(serverConfig.appUrl ?? 'http://localhost:3000');
    const hostedAuthCopy = resolveHostedAuthPageCopy(
        parsedConfig.data.hostedAuth.copy,
        createDefaultHostedAuthPageCopy(),
        'hostedAuth.copy',
    );
    const hostedAuthBranding = resolveHostedAuthBranding(
        parsedConfig.data.hostedAuth.branding,
        createDefaultHostedAuthBranding(),
        'hostedAuth.branding',
    );
    const jwtSecret = parseConfiguredSecret(parsedConfig.data.auth.jwtSecret, 'auth.jwtSecret');
    const emailSecret = parseConfiguredSecret(
        parsedConfig.data.auth.emailSecret,
        'auth.emailSecret',
    );
    const csrfSecret = parseConfiguredSecret(parsedConfig.data.auth.csrfSecret, 'auth.csrfSecret');
    const previewSecret = parseConfiguredSecret(
        parsedConfig.data.auth.previewSecret,
        'auth.previewSecret',
    );
    const securityStateAdapter = securityStateConfig.adapter ?? 'file';
    const securityStateRedisUrl =
        securityStateAdapter === 'redis'
            ? parseRedisUrl(
                  securityStateConfig.redisUrl ??
                      (() => {
                          throw new Error(
                              'server.securityState.redisUrl must be configured when server.securityState.adapter = "redis".',
                          );
                      })(),
                  'server.securityState.redisUrl',
              )
            : undefined;
    validateDistinctSecrets(jwtSecret, emailSecret, csrfSecret, previewSecret);

    const sites = parsedConfig.data.sites.map((site) => ({
        id: site.id,
        origins: parseOrigins(site.origins, `sites[${site.id}].origins`),
        allowedRedirectUris: parseAllowedRedirectUris(
            site.allowedRedirectUris,
            `sites[${site.id}].allowedRedirectUris`,
        ),
        accessRules: buildSiteAccessRules(site),
        hostedAuthPageCopy: resolveHostedAuthPageCopy(
            site.hostedAuth?.copy,
            hostedAuthCopy,
            `sites[${site.id}].hostedAuth.copy`,
        ),
        hostedAuthBranding: resolveHostedAuthBranding(
            site.hostedAuth?.branding,
            hostedAuthBranding,
            `sites[${site.id}].hostedAuth.branding`,
        ),
    }));

    const siteIds = new Set<string>();
    const siteOriginOwners = new Map<string, string>();
    for (const site of sites) {
        if (siteIds.has(site.id)) {
            throw new Error(`sites contains a duplicate id: ${site.id}`);
        }
        siteIds.add(site.id);

        for (const origin of site.origins) {
            const existingOwner = siteOriginOwners.get(origin);
            if (typeof existingOwner === 'string') {
                throw new Error(
                    `Site origins must be unique. ${origin} is configured for both ${existingOwner} and ${site.id}.`,
                );
            }

            siteOriginOwners.set(origin, site.id);
        }

        for (const redirectUri of site.allowedRedirectUris) {
            if (!site.origins.has(redirectUri.origin)) {
                throw new Error(
                    `sites[${site.id}].allowedRedirectUris must stay within the configured site origins.`,
                );
            }
        }
    }

    return {
        appPort: serverConfig.appPort ?? 3000,
        appUrl: serverConfig.appUrl ?? 'http://localhost:3000',
        csrfSecret,
        cookieDomain: cookieConfig.domain,
        cookieHttpOnly: parseCookieHttpOnly(cookieConfig.httpOnly),
        cookieName: cookieConfig.name ?? 'magic-sso',
        cookiePath: cookieConfig.path,
        cookieSameSite: parseCookieSameSite(cookieConfig.sameSite, appUrl),
        cookieSecure: parseCookieSecure(cookieConfig.secure, appUrl),
        emailExpirationSeconds: parseDurationToSeconds(parsedConfig.data.auth.emailExpiration),
        emailFrom: parsedConfig.data.email.from,
        emailSecret,
        emailSignature: parsedConfig.data.email.signature,
        emailSmtpFallbacks: parsedConfig.data.email.smtpFallbacks,
        emailSmtpHost: parsedConfig.data.email.smtp.host,
        emailSmtpPass: parsedConfig.data.email.smtp.pass,
        emailSmtpPort: parsedConfig.data.email.smtp.port,
        emailSmtpSecure: parsedConfig.data.email.smtp.secure,
        emailSmtpUser: parsedConfig.data.email.smtp.user,
        hostedAuthBranding,
        hostedAuthPageCopy: hostedAuthCopy,
        healthzRateLimitMax: rateLimitConfig.healthzMax ?? 60,
        logFormat: serverConfig.logFormat ?? 'json',
        jwtExpirationSeconds: parseDurationToSeconds(parsedConfig.data.auth.jwtExpiration),
        jwtSecret,
        previewSecret,
        logLevel: serverConfig.logLevel ?? 'info',
        rateLimitWindowMs: rateLimitConfig.windowMs ?? 10 * 60 * 1000,
        securityState: {
            adapter: securityStateAdapter,
            keyPrefix: securityStateConfig.keyPrefix ?? 'magic-sso',
            redisUrl: securityStateRedisUrl,
        },
        serveRootLandingPage: serverConfig.serveRootLandingPage ?? true,
        signInEmailRateLimitMax: rateLimitConfig.signInEmailMax ?? 5,
        signInEmailRateLimitStoreDir:
            serverConfig.signInEmailRateLimitStoreDir ?? '.magic-sso/signin-email-rate-limit',
        signInPageRateLimitMax: rateLimitConfig.signInPageMax ?? 30,
        signInRateLimitMax: rateLimitConfig.signInMax ?? 20,
        sites,
        trustProxy: serverConfig.trustProxy ?? false,
        verifyRateLimitMax: rateLimitConfig.verifyMax ?? 40,
        verifyTokenStoreDir: serverConfig.verifyTokenStoreDir ?? '.magic-sso/verification-tokens',
    };
}

export function readConfigFilePath(env: NodeJS.ProcessEnv = process.env): string {
    const filePath = env.MAGICSSO_CONFIG_FILE;
    if (typeof filePath !== 'string' || filePath.trim().length === 0) {
        throw new Error('MAGICSSO_CONFIG_FILE must point to a TOML config file.');
    }

    return filePath;
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): AppConfig {
    const filePath = readConfigFilePath(env);

    let fileContents: string;
    try {
        fileContents = readFileSync(filePath, 'utf8');
    } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        throw new Error(`Failed to read MAGICSSO_CONFIG_FILE (${filePath}): ${message}`);
    }

    const config = parseConfigToml(fileContents, filePath);
    const appUrl = new URL(config.appUrl);

    if (!config.cookieSecure && !isLocalHttpUrl(appUrl)) {
        process.emitWarning(
            'cookie.secure=false outside http://localhost will issue auth cookies without the Secure flag.',
            {
                code: 'MAGICSSO_INSECURE_COOKIE',
            },
        );
    }

    return config;
}
