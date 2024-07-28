/**
 * server/src/config.test.ts
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

import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
    createDefaultHostedAuthBranding,
    createDefaultHostedAuthPageCopy,
    loadConfig,
} from './config.js';

const JWT_SECRET = 'jwt-secret-0123456789-0123456789';
const CSRF_SECRET = 'csrf-secret-0123456789-012345678';
const EMAIL_SECRET = 'email-secret-0123456789-01234567';
const PREVIEW_SECRET = 'preview-secret-0123456789-0123456';
const SHORT_SECRET = 'short-secret';

function baseToml(extraSections = ''): string {
    return `
[server]
appUrl = "http://localhost:3000"

[auth]
jwtSecret = "jwt-secret"
csrfSecret = "csrf-secret"
emailSecret = "email-secret"
previewSecret = "preview-secret"

[email]
from = "owner@example.com"
signature = "Magic Link SSO"

[email.smtp]
host = "smtp.example.com"
port = 587
user = "smtp-user"
pass = "smtp-password"
secure = false

[[sites]]
id = "client"
origins = ["http://client.example.com"]
allowedRedirectUris = ["http://client.example.com/verify-email", "http://client.example.com/*"]
allowedEmails = ["user@example.com", "admin@example.com"]
${extraSections}
`.trimStart();
}

function withSecureTestSecrets(contents: string): string {
    return contents
        .replaceAll('"jwt-secret"', `"${JWT_SECRET}"`)
        .replaceAll('"csrf-secret"', `"${CSRF_SECRET}"`)
        .replaceAll('"email-secret"', `"${EMAIL_SECRET}"`)
        .replaceAll('"preview-secret"', `"${PREVIEW_SECRET}"`);
}

function createConfigFile(contents: string): { cleanup: () => void; path: string } {
    const tempDir = mkdtempSync(join(tmpdir(), 'magic-sso-config-'));
    const filePath = join(tempDir, 'magic-sso.toml');
    writeFileSync(filePath, withSecureTestSecrets(contents), 'utf8');

    return {
        path: filePath,
        cleanup: () => {
            rmSync(tempDir, { recursive: true, force: true });
        },
    };
}

function loadConfigFromToml(contents: string): {
    cleanup: () => void;
    config: ReturnType<typeof loadConfig>;
} {
    const file = createConfigFile(contents);

    return {
        cleanup: file.cleanup,
        config: loadConfig({
            MAGICSSO_CONFIG_FILE: file.path,
        }),
    };
}

describe('loadConfig', () => {
    afterEach(() => {
        vi.restoreAllMocks();
    });

    it('loads a TOML config file and normalizes site settings', () => {
        const { cleanup, config } = loadConfigFromToml(baseToml());

        try {
            expect(config.appPort).toBe(3000);
            expect(config.appUrl).toBe('http://localhost:3000');
            expect(config.csrfSecret).toBe(CSRF_SECRET);
            expect(config.cookieHttpOnly).toBe(true);
            expect(config.cookieName).toBe('magic-sso');
            expect(config.emailSmtpPort).toBe(587);
            expect(config.emailSmtpSecure).toBe(false);
            expect(config.emailSmtpFallbacks).toEqual([]);
            expect(config.healthzRateLimitMax).toBe(60);
            expect(config.hostedAuthBranding).toEqual(createDefaultHostedAuthBranding());
            expect(config.hostedAuthPageCopy).toEqual(createDefaultHostedAuthPageCopy());
            expect(config.logFormat).toBe('json');
            expect(config.securityState).toEqual({
                adapter: 'file',
                keyPrefix: 'magic-sso',
                redisUrl: undefined,
            });
            expect(config.serveRootLandingPage).toBe(true);
            expect(config.signInEmailRateLimitMax).toBe(5);
            expect(config.signInEmailRateLimitStoreDir).toBe('.magic-sso/signin-email-rate-limit');
            expect(config.sites).toHaveLength(1);
            expect(config.sites[0]?.id).toBe('client');
            expect(config.sites[0]?.accessRules.get('user@example.com')).toEqual(new Set(['*']));
            expect(config.sites[0]?.accessRules.get('admin@example.com')).toEqual(new Set(['*']));
            expect(config.sites[0]?.origins.has('http://client.example.com')).toBe(true);
            expect(config.sites[0]?.allowedRedirectUris).toEqual([
                {
                    match: 'exact',
                    origin: 'http://client.example.com',
                    pathname: '/verify-email',
                },
                {
                    match: 'subpath',
                    origin: 'http://client.example.com',
                    pathname: '/',
                },
            ]);
        } finally {
            cleanup();
        }
    });

    it('parses exact and strict sub-path redirect URI allowlist entries', () => {
        const { cleanup, config } = loadConfigFromToml(
            `
[server]
appUrl = "http://localhost:3000"

[auth]
jwtSecret = "jwt-secret"
csrfSecret = "csrf-secret"
emailSecret = "email-secret"
previewSecret = "preview-secret"

[email]
from = "owner@example.com"

[email.smtp]
host = "smtp.example.com"
user = "smtp-user"
pass = "smtp-password"

[[sites]]
id = "client"
origins = ["http://client.example.com"]
allowedRedirectUris = [
    "http://client.example.com/verify-email",
    "http://client.example.com/app/*",
]
allowedEmails = ["user@example.com"]
`.trimStart(),
        );

        try {
            expect(config.sites[0]?.allowedRedirectUris).toEqual([
                {
                    match: 'exact',
                    origin: 'http://client.example.com',
                    pathname: '/verify-email',
                },
                {
                    match: 'subpath',
                    origin: 'http://client.example.com',
                    pathname: '/app/',
                },
            ]);
        } finally {
            cleanup();
        }
    });

    it('parses access rules and preserves scope casing', () => {
        const { cleanup, config } = loadConfigFromToml(
            `
[server]
appUrl = "http://localhost:3000"

[auth]
jwtSecret = "jwt-secret"
csrfSecret = "csrf-secret"
emailSecret = "email-secret"
previewSecret = "preview-secret"

[email]
from = "owner@example.com"

[email.smtp]
host = "smtp.example.com"
user = "smtp-user"
pass = "smtp-password"

[[sites]]
id = "client"
origins = ["http://client.example.com"]
allowedRedirectUris = ["http://client.example.com/verify-email", "http://client.example.com/*"]

[[sites.accessRules]]
email = "user@example.com"
scopes = ["album-A", "Album-B"]
`.trimStart(),
        );

        try {
            expect(config.sites[0]?.accessRules.get('user@example.com')).toEqual(
                new Set(['album-A', 'Album-B']),
            );
        } finally {
            cleanup();
        }
    });

    it('parses server.serveRootLandingPage', () => {
        const { cleanup, config } = loadConfigFromToml(
            `
[server]
appUrl = "http://localhost:3000"
serveRootLandingPage = false

[auth]
jwtSecret = "jwt-secret"
csrfSecret = "csrf-secret"
emailSecret = "email-secret"
previewSecret = "preview-secret"

[email]
from = "owner@example.com"
signature = "Magic Link SSO"

[email.smtp]
host = "smtp.example.com"
port = 587
user = "smtp-user"
pass = "smtp-password"
secure = false

[[sites]]
id = "client"
origins = ["http://client.example.com"]
allowedRedirectUris = ["http://client.example.com/verify-email", "http://client.example.com/*"]
allowedEmails = ["user@example.com", "admin@example.com"]
`.trimStart(),
        );

        try {
            expect(config.serveRootLandingPage).toBe(false);
        } finally {
            cleanup();
        }
    });

    it('merges legacy allowed emails with access rules for the same email', () => {
        const { cleanup, config } = loadConfigFromToml(
            `
[server]
appUrl = "http://localhost:3000"

[auth]
jwtSecret = "jwt-secret"
csrfSecret = "csrf-secret"
emailSecret = "email-secret"
previewSecret = "preview-secret"

[email]
from = "owner@example.com"

[email.smtp]
host = "smtp.example.com"
user = "smtp-user"
pass = "smtp-password"

[[sites]]
id = "client"
origins = ["http://client.example.com"]
allowedRedirectUris = ["http://client.example.com/verify-email", "http://client.example.com/*"]
allowedEmails = ["user@example.com"]

[[sites.accessRules]]
email = "user@example.com"
scopes = ["album-A", "album-B"]
`.trimStart(),
        );

        try {
            expect(config.sites[0]?.accessRules.get('user@example.com')).toEqual(
                new Set(['*', 'album-A', 'album-B']),
            );
        } finally {
            cleanup();
        }
    });

    it('fails fast for empty access rule scopes', () => {
        expect(() =>
            loadConfigFromToml(
                `
[server]
appUrl = "http://localhost:3000"

[auth]
jwtSecret = "jwt-secret"
csrfSecret = "csrf-secret"
emailSecret = "email-secret"
previewSecret = "preview-secret"

[email]
from = "owner@example.com"

[email.smtp]
host = "smtp.example.com"
user = "smtp-user"
pass = "smtp-password"

[[sites]]
id = "client"
origins = ["http://client.example.com"]
allowedRedirectUris = ["http://client.example.com/verify-email", "http://client.example.com/*"]

[[sites.accessRules]]
email = "user@example.com"
scopes = ["   "]
`.trimStart(),
            ),
        ).toThrowError('sites[client].accessRules[0].scopes must contain at least one scope.');
    });

    it('fails fast when a site defines neither allowed emails nor access rules', () => {
        expect(() =>
            loadConfigFromToml(
                `
[server]
appUrl = "http://localhost:3000"

[auth]
jwtSecret = "jwt-secret"
csrfSecret = "csrf-secret"
emailSecret = "email-secret"
previewSecret = "preview-secret"

[email]
from = "owner@example.com"

[email.smtp]
host = "smtp.example.com"
user = "smtp-user"
pass = "smtp-password"

[[sites]]
id = "client"
origins = ["http://client.example.com"]
allowedRedirectUris = ["http://client.example.com/verify-email", "http://client.example.com/*"]
`.trimStart(),
            ),
        ).toThrowError(/Each site must define allowedEmails, accessRules, or both\./u);
    });

    it('defaults cookie.secure to true for HTTPS deployments', () => {
        const { cleanup, config } = loadConfigFromToml(
            `
[server]
appUrl = "https://sso.example.com"

[auth]
jwtSecret = "jwt-secret"
csrfSecret = "csrf-secret"
emailSecret = "email-secret"
previewSecret = "preview-secret"

[email]
from = "owner@example.com"

[email.smtp]
host = "smtp.example.com"
user = "smtp-user"
pass = "smtp-password"

[[sites]]
id = "client"
origins = ["http://client.example.com"]
allowedRedirectUris = ["http://client.example.com/verify-email", "http://client.example.com/*"]
allowedEmails = ["user@example.com"]
`.trimStart(),
        );

        try {
            expect(config.cookieSecure).toBe(true);
        } finally {
            cleanup();
        }
    });

    it('fails fast when HTTPS deployments disable cookie.secure', () => {
        expect(() =>
            loadConfigFromToml(
                `
[server]
appUrl = "https://sso.example.com"

[auth]
jwtSecret = "jwt-secret"
csrfSecret = "csrf-secret"
emailSecret = "email-secret"
previewSecret = "preview-secret"

[cookie]
secure = false

[email]
from = "owner@example.com"

[email.smtp]
host = "smtp.example.com"
user = "smtp-user"
pass = "smtp-password"

[[sites]]
id = "client"
origins = ["http://client.example.com"]
allowedRedirectUris = ["http://client.example.com/verify-email", "http://client.example.com/*"]
allowedEmails = ["user@example.com"]
`.trimStart(),
            ),
        ).toThrowError(
            'cookie.secure must be true when server.appUrl uses HTTPS to avoid issuing auth cookies without the Secure flag.',
        );
    });

    it('fails fast when cookie.httpOnly is disabled', () => {
        expect(() =>
            loadConfigFromToml(
                `
[server]
appUrl = "http://localhost:3000"

[auth]
jwtSecret = "jwt-secret"
csrfSecret = "csrf-secret"
emailSecret = "email-secret"
previewSecret = "preview-secret"

[cookie]
httpOnly = false

[email]
from = "owner@example.com"

[email.smtp]
host = "smtp.example.com"
user = "smtp-user"
pass = "smtp-password"

[[sites]]
id = "client"
origins = ["http://client.example.com"]
allowedRedirectUris = ["http://client.example.com/verify-email", "http://client.example.com/*"]
allowedEmails = ["user@example.com"]
`.trimStart(),
            ),
        ).toThrowError(
            'cookie.httpOnly must remain true because Magic Link SSO session cookies contain bearer JWTs.',
        );
    });

    it('fails fast when cookie.sameSite=none is configured for non-HTTPS deployments', () => {
        expect(() =>
            loadConfigFromToml(
                `
[server]
appUrl = "http://sso.example.com"

[auth]
jwtSecret = "jwt-secret"
csrfSecret = "csrf-secret"
emailSecret = "email-secret"
previewSecret = "preview-secret"

[cookie]
sameSite = "none"

[email]
from = "owner@example.com"

[email.smtp]
host = "smtp.example.com"
user = "smtp-user"
pass = "smtp-password"

[[sites]]
id = "client"
origins = ["http://client.example.com"]
allowedRedirectUris = ["http://client.example.com/verify-email", "http://client.example.com/*"]
allowedEmails = ["user@example.com"]
`.trimStart(),
            ),
        ).toThrowError(
            'cookie.sameSite = "none" requires server.appUrl to use HTTPS so browsers will accept the cookie.',
        );
    });

    it('parses SMTP fallback transports from TOML arrays of tables', () => {
        const { cleanup, config } = loadConfigFromToml(
            `
[server]
appUrl = "http://localhost:3000"

[auth]
jwtSecret = "jwt-secret"
csrfSecret = "csrf-secret"
emailSecret = "email-secret"
previewSecret = "preview-secret"

[email]
from = "owner@example.com"
signature = "Magic Link SSO"

[email.smtp]
host = "smtp.example.com"
port = 1025
user = "smtp-user"
pass = "smtp-password"
secure = true

[[email.smtpFallbacks]]
host = "smtp-backup.example.com"
port = 2525
user = "backup-user"
pass = "backup-pass"
secure = false

[[sites]]
id = "client"
origins = ["http://client.example.com"]
allowedRedirectUris = ["http://client.example.com/verify-email", "http://client.example.com/*"]
allowedEmails = ["user@example.com"]
`.trimStart(),
        );

        try {
            expect(config.emailSmtpPort).toBe(1025);
            expect(config.emailSmtpSecure).toBe(true);
            expect(config.emailSmtpFallbacks).toEqual([
                {
                    host: 'smtp-backup.example.com',
                    port: 2525,
                    user: 'backup-user',
                    pass: 'backup-pass',
                    secure: false,
                },
            ]);
        } finally {
            cleanup();
        }
    });

    it('parses server.logFormat as json', () => {
        const { cleanup, config } = loadConfigFromToml(
            `
[server]
appUrl = "http://localhost:3000"
logFormat = "json"

[auth]
jwtSecret = "jwt-secret"
csrfSecret = "csrf-secret"
emailSecret = "email-secret"
previewSecret = "preview-secret"

[email]
from = "owner@example.com"

[email.smtp]
host = "smtp.example.com"
user = "smtp-user"
pass = "smtp-password"

[[sites]]
id = "client"
origins = ["http://client.example.com"]
allowedRedirectUris = ["http://client.example.com/verify-email", "http://client.example.com/*"]
allowedEmails = ["user@example.com"]
`.trimStart(),
        );

        try {
            expect(config.logFormat).toBe('json');
        } finally {
            cleanup();
        }
    });

    it('parses server.logFormat as pretty', () => {
        const { cleanup, config } = loadConfigFromToml(
            `
[server]
appUrl = "http://localhost:3000"
logFormat = "pretty"

[auth]
jwtSecret = "jwt-secret"
csrfSecret = "csrf-secret"
emailSecret = "email-secret"
previewSecret = "preview-secret"

[email]
from = "owner@example.com"

[email.smtp]
host = "smtp.example.com"
user = "smtp-user"
pass = "smtp-password"

[[sites]]
id = "client"
origins = ["http://client.example.com"]
allowedRedirectUris = ["http://client.example.com/verify-email", "http://client.example.com/*"]
allowedEmails = ["user@example.com"]
`.trimStart(),
        );

        try {
            expect(config.logFormat).toBe('pretty');
        } finally {
            cleanup();
        }
    });

    it('parses explicit per-email and healthz rate limits', () => {
        const { cleanup, config } = loadConfigFromToml(
            `
[server]
appUrl = "http://localhost:3000"
signInEmailRateLimitStoreDir = "/tmp/magic-sso/signin-email-rate-limit"

[auth]
jwtSecret = "jwt-secret"
csrfSecret = "csrf-secret"
emailSecret = "email-secret"
previewSecret = "preview-secret"

[email]
from = "owner@example.com"

[email.smtp]
host = "smtp.example.com"
user = "smtp-user"
pass = "smtp-password"

[rateLimit]
healthzMax = 77
signInEmailMax = 3

[[sites]]
id = "client"
origins = ["http://client.example.com"]
allowedRedirectUris = ["http://client.example.com/verify-email", "http://client.example.com/*"]
allowedEmails = ["user@example.com"]
`.trimStart(),
        );

        try {
            expect(config.healthzRateLimitMax).toBe(77);
            expect(config.signInEmailRateLimitMax).toBe(3);
            expect(config.signInEmailRateLimitStoreDir).toBe(
                '/tmp/magic-sso/signin-email-rate-limit',
            );
        } finally {
            cleanup();
        }
    });

    it('parses Redis-backed shared security state settings', () => {
        const { cleanup, config } = loadConfigFromToml(
            `
[server]
appUrl = "http://localhost:3000"

[server.securityState]
adapter = "redis"
redisUrl = "redis://127.0.0.1:6379/0"
keyPrefix = "magic-sso-prod"

[auth]
jwtSecret = "jwt-secret"
csrfSecret = "csrf-secret"
emailSecret = "email-secret"
previewSecret = "preview-secret"

[email]
from = "owner@example.com"

[email.smtp]
host = "smtp.example.com"
user = "smtp-user"
pass = "smtp-password"

[[sites]]
id = "client"
origins = ["http://client.example.com"]
allowedRedirectUris = ["http://client.example.com/verify-email", "http://client.example.com/*"]
allowedEmails = ["user@example.com"]
`.trimStart(),
        );

        try {
            expect(config.securityState).toEqual({
                adapter: 'redis',
                keyPrefix: 'magic-sso-prod',
                redisUrl: 'redis://127.0.0.1:6379/0',
            });
        } finally {
            cleanup();
        }
    });

    it('rejects Redis shared security state without a redisUrl', () => {
        expect(() =>
            loadConfigFromToml(
                `
[server]
appUrl = "http://localhost:3000"

[server.securityState]
adapter = "redis"

[auth]
jwtSecret = "jwt-secret"
csrfSecret = "csrf-secret"
emailSecret = "email-secret"
previewSecret = "preview-secret"

[email]
from = "owner@example.com"

[email.smtp]
host = "smtp.example.com"
user = "smtp-user"
pass = "smtp-password"

[[sites]]
id = "client"
origins = ["http://client.example.com"]
allowedRedirectUris = ["http://client.example.com/verify-email", "http://client.example.com/*"]
allowedEmails = ["user@example.com"]
`.trimStart(),
            ),
        ).toThrow(
            'server.securityState.redisUrl must be configured when server.securityState.adapter = "redis".',
        );
    });

    it('merges root and site hosted auth overrides', () => {
        const { cleanup, config } = loadConfigFromToml(
            baseToml(`
[hostedAuth.copy]
lang = "pl"

[hostedAuth.copy.signin]
title = "Zaloguj się"
submitButton = "Wyślij link"

[hostedAuth.branding]
title = "Acme Cloud"
logoText = "AC"
supportText = "Need help?"
supportLinkText = "Contact support"
supportLinkUrl = "mailto:support@example.com"

[hostedAuth.branding.signinCssVariables]
"--color-button-background" = "#112233"

[sites.hostedAuth.copy.verifyEmail]
continueButton = "Kontynuuj"
emailLabel = "Adres e-mail"
`),
        );

        try {
            expect(config.hostedAuthPageCopy.lang).toBe('pl');
            expect(config.hostedAuthPageCopy.signin.title).toBe('Zaloguj się');
            expect(config.hostedAuthBranding.title).toBe('Acme Cloud');
            expect(config.hostedAuthBranding.logoText).toBe('AC');
            expect(config.hostedAuthBranding.signinCssVariables['--color-button-background']).toBe(
                '#112233',
            );
            expect(config.sites[0]?.hostedAuthPageCopy.verifyEmail.continueButton).toBe(
                'Kontynuuj',
            );
            expect(config.sites[0]?.hostedAuthPageCopy.verifyEmail.emailLabel).toBe('Adres e-mail');
            expect(config.sites[0]?.hostedAuthPageCopy.signin.title).toBe('Zaloguj się');
        } finally {
            cleanup();
        }
    });

    it('rejects unsafe hosted auth CSS variable values', () => {
        expect(() =>
            loadConfigFromToml(
                baseToml(`
[hostedAuth.branding.signinCssVariables]
"--color-button-background" = "red; background: url(https://evil.example)"

[hostedAuth.branding.verifyEmailCssVariables]
"--color-card-shadow" = "0 24px 64px rgba(0, 0, 0, 0.2) } body { color: red"
`),
            ),
        ).toThrowError(
            'CSS variable values must not include declarations, blocks, escapes, control characters, quotes, or URLs.',
        );
    });

    it('rejects hosted auth CSS variable values that use CSS hex escapes', () => {
        expect(() =>
            loadConfigFromToml(
                baseToml(`
[hostedAuth.branding.signinCssVariables]
"--color-button-background" = "red\\\\3B \\\\7D :root\\\\7B background:\\\\75 rl(//evil.example/?x=1)\\\\3B\\\\7D"
`),
            ),
        ).toThrowError(
            'CSS variable values must not include declarations, blocks, escapes, control characters, quotes, or URLs.',
        );
    });

    it('fails fast for invalid hosted auth branding URLs', () => {
        expect(() =>
            loadConfigFromToml(
                baseToml(`
[hostedAuth.branding]
logoImageUrl = "javascript:alert(1)"
`),
            ),
        ).toThrowError(
            'hostedAuth.branding.logoImageUrl must be an absolute http(s) URL, a site-relative path, and not an unsupported protocol.',
        );
    });

    it('fails fast for duplicate site ids', () => {
        expect(() =>
            loadConfigFromToml(
                baseToml(`
[[sites]]
id = "client"
origins = ["http://other.example.com"]
allowedRedirectUris = ["http://other.example.com/verify-email", "http://other.example.com/*"]
allowedEmails = ["ops@example.com"]
`),
            ),
        ).toThrowError('sites contains a duplicate id: client');
    });

    it('fails fast for overlapping site origins', () => {
        expect(() =>
            loadConfigFromToml(
                baseToml(`
[[sites]]
id = "other"
origins = ["http://client.example.com"]
allowedRedirectUris = ["http://client.example.com/verify-email", "http://client.example.com/*"]
allowedEmails = ["ops@example.com"]
`),
            ),
        ).toThrowError(
            'Site origins must be unique. http://client.example.com is configured for both client and other.',
        );
    });

    it('fails fast when auth.csrfSecret reuses the JWT secret', () => {
        expect(() =>
            loadConfigFromToml(
                `
[server]
appUrl = "http://localhost:3000"

[auth]
jwtSecret = "jwt-secret"
csrfSecret = "jwt-secret"
emailSecret = "email-secret"
previewSecret = "preview-secret"

[email]
from = "owner@example.com"

[email.smtp]
host = "smtp.example.com"
user = "smtp-user"
pass = "smtp-password"

[[sites]]
id = "client"
origins = ["http://client.example.com"]
allowedRedirectUris = ["http://client.example.com/verify-email", "http://client.example.com/*"]
allowedEmails = ["user@example.com"]
`.trimStart(),
            ),
        ).toThrowError('auth.csrfSecret must differ from auth.jwtSecret.');
    });

    it('fails fast when auth.emailSecret reuses the JWT secret', () => {
        expect(() =>
            loadConfigFromToml(
                `
[server]
appUrl = "http://localhost:3000"

[auth]
jwtSecret = "jwt-secret"
csrfSecret = "csrf-secret"
emailSecret = "jwt-secret"
previewSecret = "preview-secret"

[email]
from = "owner@example.com"

[email.smtp]
host = "smtp.example.com"
user = "smtp-user"
pass = "smtp-password"

[[sites]]
id = "client"
origins = ["http://client.example.com"]
allowedRedirectUris = ["http://client.example.com/verify-email", "http://client.example.com/*"]
allowedEmails = ["user@example.com"]
`.trimStart(),
            ),
        ).toThrowError('auth.emailSecret must differ from auth.jwtSecret.');
    });

    it('fails fast when auth.emailSecret reuses the CSRF secret', () => {
        expect(() =>
            loadConfigFromToml(
                `
[server]
appUrl = "http://localhost:3000"

[auth]
jwtSecret = "jwt-secret"
csrfSecret = "csrf-secret"
emailSecret = "csrf-secret"
previewSecret = "preview-secret"

[email]
from = "owner@example.com"

[email.smtp]
host = "smtp.example.com"
user = "smtp-user"
pass = "smtp-password"

[[sites]]
id = "client"
origins = ["http://client.example.com"]
allowedRedirectUris = ["http://client.example.com/verify-email", "http://client.example.com/*"]
allowedEmails = ["user@example.com"]
`.trimStart(),
            ),
        ).toThrowError('auth.emailSecret must differ from auth.csrfSecret.');
    });

    it.each([
        {
            authSection: `
[auth]
jwtSecret = "${SHORT_SECRET}"
csrfSecret = "csrf-secret"
emailSecret = "email-secret"
previewSecret = "preview-secret"
`.trim(),
            errorMessage: 'auth.jwtSecret must be at least 32 characters long.',
            title: 'auth.jwtSecret',
        },
        {
            authSection: `
[auth]
jwtSecret = "jwt-secret"
csrfSecret = "${SHORT_SECRET}"
emailSecret = "email-secret"
previewSecret = "preview-secret"
`.trim(),
            errorMessage: 'auth.csrfSecret must be at least 32 characters long.',
            title: 'auth.csrfSecret',
        },
        {
            authSection: `
[auth]
jwtSecret = "jwt-secret"
csrfSecret = "csrf-secret"
emailSecret = "${SHORT_SECRET}"
previewSecret = "preview-secret"
`.trim(),
            errorMessage: 'auth.emailSecret must be at least 32 characters long.',
            title: 'auth.emailSecret',
        },
    ])('fails fast when $title is shorter than 32 characters', ({ authSection, errorMessage }) => {
        expect(() =>
            loadConfigFromToml(
                `
[server]
appUrl = "http://localhost:3000"

${authSection}

[email]
from = "owner@example.com"

[email.smtp]
host = "smtp.example.com"
user = "smtp-user"
pass = "smtp-password"

[[sites]]
id = "client"
origins = ["http://client.example.com"]
allowedRedirectUris = ["http://client.example.com/verify-email", "http://client.example.com/*"]
allowedEmails = ["user@example.com"]
`.trimStart(),
            ),
        ).toThrowError(errorMessage);
    });

    it('fails fast when auth.jwtSecret still uses the example placeholder', () => {
        expect(() =>
            loadConfigFromToml(
                `
[server]
appUrl = "http://localhost:3000"

[auth]
jwtSecret = "replace-me-with-a-long-random-jwt-secret"
csrfSecret = "csrf-secret"
emailSecret = "email-secret"
previewSecret = "preview-secret"

[email]
from = "owner@example.com"

[email.smtp]
host = "smtp.example.com"
user = "smtp-user"
pass = "smtp-password"

[[sites]]
id = "client"
origins = ["http://client.example.com"]
allowedRedirectUris = ["http://client.example.com/verify-email", "http://client.example.com/*"]
allowedEmails = ["user@example.com"]
`.trimStart(),
            ),
        ).toThrowError('auth.jwtSecret must be replaced with a real secret value.');
    });

    it('fails fast when auth.previewSecret still uses the example placeholder', () => {
        expect(() =>
            loadConfigFromToml(
                `
[server]
appUrl = "http://localhost:3000"

[auth]
jwtSecret = "jwt-secret"
csrfSecret = "csrf-secret"
emailSecret = "email-secret"
previewSecret = "replace-me-with-a-different-long-random-preview-secret"

[email]
from = "owner@example.com"

[email.smtp]
host = "smtp.example.com"
user = "smtp-user"
pass = "smtp-password"

[[sites]]
id = "client"
origins = ["http://client.example.com"]
allowedRedirectUris = ["http://client.example.com/verify-email", "http://client.example.com/*"]
allowedEmails = ["user@example.com"]
`.trimStart(),
            ),
        ).toThrowError('auth.previewSecret must be replaced with a real secret value.');
    });

    it('warns when cookie.secure is disabled outside localhost HTTP', () => {
        const emitWarningSpy = vi.spyOn(process, 'emitWarning').mockImplementation(() => undefined);

        const { cleanup } = loadConfigFromToml(
            `
[server]
appUrl = "http://sso.example.com"

[auth]
jwtSecret = "jwt-secret"
csrfSecret = "csrf-secret"
emailSecret = "email-secret"
previewSecret = "preview-secret"

[cookie]
secure = false

[email]
from = "owner@example.com"

[email.smtp]
host = "smtp.example.com"
user = "smtp-user"
pass = "smtp-password"

[[sites]]
id = "client"
origins = ["http://client.example.com"]
allowedRedirectUris = ["http://client.example.com/verify-email", "http://client.example.com/*"]
allowedEmails = ["user@example.com"]
`.trimStart(),
        );

        try {
            expect(emitWarningSpy).toHaveBeenCalledWith(
                'cookie.secure=false outside http://localhost will issue auth cookies without the Secure flag.',
                {
                    code: 'MAGICSSO_INSECURE_COOKIE',
                },
            );
        } finally {
            cleanup();
        }
    });

    it('does not warn when cookie.secure is disabled for localhost HTTP development', () => {
        const emitWarningSpy = vi.spyOn(process, 'emitWarning').mockImplementation(() => undefined);

        const { cleanup } = loadConfigFromToml(baseToml());

        try {
            expect(emitWarningSpy).not.toHaveBeenCalled();
        } finally {
            cleanup();
        }
    });

    it('fails fast when MAGICSSO_CONFIG_FILE is missing', () => {
        expect(() => loadConfig({})).toThrowError(
            'MAGICSSO_CONFIG_FILE must point to a TOML config file.',
        );
    });

    it('fails fast when the config file cannot be read', () => {
        expect(() =>
            loadConfig({
                MAGICSSO_CONFIG_FILE: '/tmp/does-not-exist-magic-sso.toml',
            }),
        ).toThrowError(/Failed to read MAGICSSO_CONFIG_FILE/u);
    });

    it('fails fast when server.logFormat is unsupported', () => {
        expect(() =>
            loadConfigFromToml(
                `
[server]
appUrl = "http://localhost:3000"
logFormat = "plain"

[auth]
jwtSecret = "jwt-secret"
csrfSecret = "csrf-secret"
emailSecret = "email-secret"
previewSecret = "preview-secret"

[email]
from = "owner@example.com"

[email.smtp]
host = "smtp.example.com"
user = "smtp-user"
pass = "smtp-password"

[[sites]]
id = "client"
origins = ["http://client.example.com"]
allowedRedirectUris = ["http://client.example.com/verify-email", "http://client.example.com/*"]
allowedEmails = ["user@example.com"]
`.trimStart(),
            ),
        ).toThrowError(/Failed to validate MAGICSSO_CONFIG_FILE/u);
    });

    it('reports the config path when a required field is missing', () => {
        expect(() =>
            loadConfigFromToml(
                `
[server]
appUrl = "http://localhost:3000"

[auth]
jwtSecret = "jwt-secret"
csrfSecret = "csrf-secret"
emailSecret = "email-secret"

[email]
from = "owner@example.com"

[email.smtp]
host = "smtp.example.com"
user = "smtp-user"
pass = "smtp-password"

[[sites]]
id = "client"
origins = ["http://client.example.com"]
allowedRedirectUris = ["http://client.example.com/verify-email", "http://client.example.com/*"]
allowedEmails = ["user@example.com"]
`.trimStart(),
            ),
        ).toThrowError(/auth\.previewSecret: Invalid input: expected string, received undefined/u);
    });

    it('fails fast when the TOML is invalid', () => {
        const file = createConfigFile('[[sites]\nid = "broken"\n');

        try {
            expect(() =>
                loadConfig({
                    MAGICSSO_CONFIG_FILE: file.path,
                }),
            ).toThrowError(/Failed to parse MAGICSSO_CONFIG_FILE/u);
        } finally {
            file.cleanup();
        }
    });

    it('accepts an absolute https URL for hostedAuth.branding.logoImageUrl', () => {
        const { cleanup, config } = loadConfigFromToml(
            baseToml(`
[hostedAuth.branding]
logoImageUrl = "https://cdn.example.com/logo.png"
`),
        );

        try {
            expect(config.hostedAuthBranding.logoImageUrl).toBe('https://cdn.example.com/logo.png');
        } finally {
            cleanup();
        }
    });

    it('rejects a malformed URL for hostedAuth.branding.logoImageUrl', () => {
        expect(() =>
            loadConfigFromToml(
                baseToml(`
[hostedAuth.branding]
logoImageUrl = "not a valid url"
`),
            ),
        ).toThrowError(/must be an absolute http\(s\) URL/u);
    });

    it('accepts a site-relative path for hostedAuth.branding.logoImageUrl', () => {
        const { cleanup, config } = loadConfigFromToml(
            baseToml(`
[hostedAuth.branding]
logoImageUrl = "/assets/logo.png"
`),
        );
        try {
            expect(config.hostedAuthBranding.logoImageUrl).toBe('/assets/logo.png');
        } finally {
            cleanup();
        }
    });

    it('rejects hostedAuth.branding when supportLinkText is set without supportLinkUrl', () => {
        expect(() =>
            loadConfigFromToml(
                baseToml(`
[hostedAuth.branding]
supportLinkText = "Get help"
`),
            ),
        ).toThrowError(/supportLinkText and supportLinkUrl must be configured together/u);
    });

    it('accepts a numeric emailExpiration value in seconds', () => {
        const { cleanup, config } = loadConfigFromToml(
            `
[server]
appUrl = "http://localhost:3000"

[auth]
jwtSecret = "jwt-secret"
csrfSecret = "csrf-secret"
emailSecret = "email-secret"
previewSecret = "preview-secret"
emailExpiration = 300

[email]
from = "owner@example.com"

[email.smtp]
host = "smtp.example.com"
port = 587
user = "smtp-user"
pass = "smtp-password"
secure = false

[[sites]]
id = "client"
origins = ["http://client.example.com"]
allowedRedirectUris = ["http://client.example.com/verify-email", "http://client.example.com/*"]
allowedEmails = ["user@example.com"]
`.trimStart(),
        );
        try {
            expect(config.emailExpirationSeconds).toBe(300);
        } finally {
            cleanup();
        }
    });

    it('accepts a plain-number string as an emailExpiration value in seconds', () => {
        const { cleanup, config } = loadConfigFromToml(
            `
[server]
appUrl = "http://localhost:3000"

[auth]
jwtSecret = "jwt-secret"
csrfSecret = "csrf-secret"
emailSecret = "email-secret"
previewSecret = "preview-secret"
emailExpiration = "300"

[email]
from = "owner@example.com"

[email.smtp]
host = "smtp.example.com"
port = 587
user = "smtp-user"
pass = "smtp-password"
secure = false

[[sites]]
id = "client"
origins = ["http://client.example.com"]
allowedRedirectUris = ["http://client.example.com/verify-email", "http://client.example.com/*"]
allowedEmails = ["user@example.com"]
`.trimStart(),
        );
        try {
            expect(config.emailExpirationSeconds).toBe(300);
        } finally {
            cleanup();
        }
    });

    it('accepts emailExpiration in seconds with the "s" suffix', () => {
        const { cleanup, config } = loadConfigFromToml(
            `
[server]
appUrl = "http://localhost:3000"

[auth]
jwtSecret = "jwt-secret"
csrfSecret = "csrf-secret"
emailSecret = "email-secret"
previewSecret = "preview-secret"
emailExpiration = "30s"

[email]
from = "owner@example.com"

[email.smtp]
host = "smtp.example.com"
port = 587
user = "smtp-user"
pass = "smtp-password"
secure = false

[[sites]]
id = "client"
origins = ["http://client.example.com"]
allowedRedirectUris = ["http://client.example.com/verify-email", "http://client.example.com/*"]
allowedEmails = ["user@example.com"]
`.trimStart(),
        );
        try {
            expect(config.emailExpirationSeconds).toBe(30);
        } finally {
            cleanup();
        }
    });

    it('accepts emailExpiration in days with the "d" suffix', () => {
        const { cleanup, config } = loadConfigFromToml(
            `
[server]
appUrl = "http://localhost:3000"

[auth]
jwtSecret = "jwt-secret"
csrfSecret = "csrf-secret"
emailSecret = "email-secret"
previewSecret = "preview-secret"
emailExpiration = "7d"

[email]
from = "owner@example.com"

[email.smtp]
host = "smtp.example.com"
port = 587
user = "smtp-user"
pass = "smtp-password"
secure = false

[[sites]]
id = "client"
origins = ["http://client.example.com"]
allowedRedirectUris = ["http://client.example.com/verify-email", "http://client.example.com/*"]
allowedEmails = ["user@example.com"]
`.trimStart(),
        );
        try {
            expect(config.emailExpirationSeconds).toBe(7 * 24 * 60 * 60);
        } finally {
            cleanup();
        }
    });

    it('rejects an emailExpiration with an unrecognised suffix', () => {
        expect(() =>
            loadConfigFromToml(
                `
[server]
appUrl = "http://localhost:3000"

[auth]
jwtSecret = "jwt-secret"
csrfSecret = "csrf-secret"
emailSecret = "email-secret"
previewSecret = "preview-secret"
emailExpiration = "5x"

[email]
from = "owner@example.com"

[email.smtp]
host = "smtp.example.com"
port = 587
user = "smtp-user"
pass = "smtp-password"
secure = false

[[sites]]
id = "client"
origins = ["http://client.example.com"]
allowedRedirectUris = ["http://client.example.com/verify-email", "http://client.example.com/*"]
allowedEmails = ["user@example.com"]
`.trimStart(),
            ),
        ).toThrowError(/Invalid duration value: 5x/u);
    });

    it('rejects sites with whitespace-only entries in allowedEmails', () => {
        expect(() =>
            loadConfigFromToml(
                `
[server]
appUrl = "http://localhost:3000"

[auth]
jwtSecret = "jwt-secret"
csrfSecret = "csrf-secret"
emailSecret = "email-secret"
previewSecret = "preview-secret"

[email]
from = "owner@example.com"

[email.smtp]
host = "smtp.example.com"
port = 587
user = "smtp-user"
pass = "smtp-password"
secure = false

[[sites]]
id = "client"
origins = ["http://client.example.com"]
allowedRedirectUris = ["http://client.example.com/verify-email", "http://client.example.com/*"]
allowedEmails = ["   "]
`.trimStart(),
            ),
        ).toThrowError(/must contain at least one email address/u);
    });

    it('rejects sites with an origin that is not a valid URL', () => {
        expect(() =>
            loadConfigFromToml(
                `
[server]
appUrl = "http://localhost:3000"

[auth]
jwtSecret = "jwt-secret"
csrfSecret = "csrf-secret"
emailSecret = "email-secret"
previewSecret = "preview-secret"

[email]
from = "owner@example.com"

[email.smtp]
host = "smtp.example.com"
port = 587
user = "smtp-user"
pass = "smtp-password"
secure = false

[[sites]]
id = "client"
origins = ["not-a-url"]
allowedRedirectUris = ["http://client.example.com/verify-email"]
allowedEmails = ["user@example.com"]
`.trimStart(),
            ),
        ).toThrowError(/must contain only absolute http\(s\) origins/u);
    });

    it('rejects sites with an origin that uses a non-http protocol', () => {
        expect(() =>
            loadConfigFromToml(
                `
[server]
appUrl = "http://localhost:3000"

[auth]
jwtSecret = "jwt-secret"
csrfSecret = "csrf-secret"
emailSecret = "email-secret"
previewSecret = "preview-secret"

[email]
from = "owner@example.com"

[email.smtp]
host = "smtp.example.com"
port = 587
user = "smtp-user"
pass = "smtp-password"
secure = false

[[sites]]
id = "client"
origins = ["ftp://files.example.com"]
allowedRedirectUris = ["http://client.example.com/verify-email"]
allowedEmails = ["user@example.com"]
`.trimStart(),
            ),
        ).toThrowError(/must contain only absolute http\(s\) origins/u);
    });

    it('rejects sites with a whitespace-only origin that collapses to an empty list', () => {
        expect(() =>
            loadConfigFromToml(
                `
[server]
appUrl = "http://localhost:3000"

[auth]
jwtSecret = "jwt-secret"
csrfSecret = "csrf-secret"
emailSecret = "email-secret"
previewSecret = "preview-secret"

[email]
from = "owner@example.com"

[email.smtp]
host = "smtp.example.com"
port = 587
user = "smtp-user"
pass = "smtp-password"
secure = false

[[sites]]
id = "client"
origins = ["   "]
allowedRedirectUris = ["http://client.example.com/verify-email"]
allowedEmails = ["user@example.com"]
`.trimStart(),
            ),
        ).toThrowError(/must contain at least one origin/u);
    });

    it('rejects redirect URI allowlist entries with query strings', () => {
        expect(() =>
            loadConfigFromToml(
                `
[server]
appUrl = "http://localhost:3000"

[auth]
jwtSecret = "jwt-secret"
csrfSecret = "csrf-secret"
emailSecret = "email-secret"
previewSecret = "preview-secret"

[email]
from = "owner@example.com"

[email.smtp]
host = "smtp.example.com"
port = 587
user = "smtp-user"
pass = "smtp-password"
secure = false

[[sites]]
id = "client"
origins = ["http://client.example.com"]
allowedRedirectUris = ["http://client.example.com/verify-email?next=/dashboard"]
allowedEmails = ["user@example.com"]
`.trimStart(),
            ),
        ).toThrowError(/must not include query strings or hash fragments/u);
    });

    it('rejects redirect URI allowlist entries with encoded path traversal', () => {
        expect(() =>
            loadConfigFromToml(
                `
[server]
appUrl = "http://localhost:3000"

[auth]
jwtSecret = "jwt-secret"
csrfSecret = "csrf-secret"
emailSecret = "email-secret"
previewSecret = "preview-secret"

[email]
from = "owner@example.com"

[email.smtp]
host = "smtp.example.com"
port = 587
user = "smtp-user"
pass = "smtp-password"
secure = false

[[sites]]
id = "client"
origins = ["http://client.example.com"]
allowedRedirectUris = ["http://client.example.com/app/%2e%2e/admin"]
allowedEmails = ["user@example.com"]
`.trimStart(),
            ),
        ).toThrowError(/must not contain encoded path traversal sequences or dot segments/u);
    });

    it('rejects redirect URI allowlist entries outside the site origins', () => {
        expect(() =>
            loadConfigFromToml(
                `
[server]
appUrl = "http://localhost:3000"

[auth]
jwtSecret = "jwt-secret"
csrfSecret = "csrf-secret"
emailSecret = "email-secret"
previewSecret = "preview-secret"

[email]
from = "owner@example.com"

[email.smtp]
host = "smtp.example.com"
port = 587
user = "smtp-user"
pass = "smtp-password"
secure = false

[[sites]]
id = "client"
origins = ["http://client.example.com"]
allowedRedirectUris = ["http://admin.example.com/verify-email"]
allowedEmails = ["user@example.com"]
`.trimStart(),
            ),
        ).toThrowError(/must stay within the configured site origins/u);
    });
});
