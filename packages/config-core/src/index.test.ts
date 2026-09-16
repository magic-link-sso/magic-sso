import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import {
    FULL_ACCESS_SCOPE,
    buildSiteAccessRules,
    loadConfig,
    parseMagicSsoConfigToml,
    parseMagicSsoTomlConfig,
    renderSiteAccessRules,
    stringifyMagicSsoTomlConfig,
    type MagicSsoTomlSite,
} from './index.js';

function createRawSite(overrides: Partial<MagicSsoTomlSite> = {}): MagicSsoTomlSite {
    return {
        accessRules: [],
        allowedEmails: ['admin@example.com'],
        allowedRedirectUris: [
            'http://client.example.com/verify-email',
            'http://client.example.com/*',
        ],
        id: 'client',
        origins: ['http://client.example.com'],
        ...overrides,
    };
}

const baseConfigToml = `
[auth]
jwtSecret = "jwt-secret-0123456789-0123456789"
csrfSecret = "csrf-secret-0123456789-012345678"
emailSecret = "email-secret-0123456789-01234567"
previewSecret = "preview-secret-0123456789-0123456"

[email]
from = "owner@example.com"

[email.smtp]
host = "smtp.example.com"
user = "smtp-user"
pass = "smtp-password"

[[sites]]
id = "client"
origins = ["http://client.example.com"]
allowedRedirectUris = ["http://client.example.com/verify-email"]
allowedEmails = ["admin@example.com"]
`.trimStart();

function withBranding(branding: string): string {
    return `${baseConfigToml}\n[hostedAuth.branding]\n${branding}\n`;
}

describe('hosted auth branding', () => {
    it('accepts site-relative paths, http(s) URLs, and mailto support links', () => {
        const config = parseMagicSsoConfigToml(
            withBranding(
                'logoImageUrl = "https://cdn.example.com/logo.svg"\nsupportLinkText = "Help"\nsupportLinkUrl = "mailto:help@example.com"',
            ),
            '/tmp/magic-sso.toml',
        );
        expect(config.hostedAuthBranding.logoImageUrl).toBe('https://cdn.example.com/logo.svg');
        expect(config.hostedAuthBranding.supportLinkUrl).toBe('mailto:help@example.com');

        expect(
            parseMagicSsoConfigToml(
                withBranding('logoImageUrl = "/logo.svg"'),
                '/tmp/magic-sso.toml',
            ).hostedAuthBranding.logoImageUrl,
        ).toBe('/logo.svg');
    });

    it.each([
        ['logoImageUrl = "//cdn.example.com/logo.svg"', /logoImageUrl.*not an invalid URL/u],
        ['logoImageUrl = "mailto:help@example.com"', /logoImageUrl.*unsupported protocol/u],
        [
            'supportLinkText = "Help"\nsupportLinkUrl = "javascript:alert(1)"',
            /supportLinkUrl.*or a mailto link/u,
        ],
        [
            'supportLinkText = "Help"\nsupportLinkUrl = "not a url"',
            /supportLinkUrl.*or a mailto link/u,
        ],
    ])('rejects unsafe branding link %s', (branding, message) => {
        expect(() =>
            parseMagicSsoConfigToml(withBranding(branding), '/tmp/magic-sso.toml'),
        ).toThrow(message);
    });

    it('rejects CSS variable values with control characters or URLs', () => {
        const withCssVariable = (value: string): string =>
            withBranding(
                `[hostedAuth.branding.signinCssVariables]\n"--color-background" = "${value}"`,
            );

        expect(
            parseMagicSsoConfigToml(withCssVariable('#ffffff'), '/tmp/magic-sso.toml')
                .hostedAuthBranding.signinCssVariables['--color-background'],
        ).toBe('#ffffff');
        expect(() =>
            parseMagicSsoConfigToml(withCssVariable('red\\u0007'), '/tmp/magic-sso.toml'),
        ).toThrow();
        expect(() =>
            parseMagicSsoConfigToml(
                withCssVariable('url(https://evil.example)'),
                '/tmp/magic-sso.toml',
            ),
        ).toThrow();
    });
});

describe('loadConfig', () => {
    function writeConfigFile(contents: string): { cleanup: () => void; filePath: string } {
        const directory = mkdtempSync(join(tmpdir(), 'magic-sso-config-core-'));
        const filePath = join(directory, 'magic-sso.toml');
        writeFileSync(filePath, contents, 'utf8');
        return {
            cleanup: () => rmSync(directory, { force: true, recursive: true }),
            filePath,
        };
    }

    it('requires MAGICSSO_CONFIG_FILE and reports unreadable files', () => {
        expect(() => loadConfig({})).toThrow(/MAGICSSO_CONFIG_FILE must point/u);
        expect(() => loadConfig({ MAGICSSO_CONFIG_FILE: '/nonexistent/magic-sso.toml' })).toThrow(
            /Failed to read MAGICSSO_CONFIG_FILE \(\/nonexistent\/magic-sso\.toml\)/u,
        );
    });

    it('warns when insecure cookies are configured outside localhost', () => {
        const configFile = writeConfigFile(
            `[server]\nappUrl = "http://sso.example.com"\n\n[cookie]\nsecure = false\n\n${baseConfigToml}`,
        );
        const emitWarning = vi.spyOn(process, 'emitWarning').mockImplementation(() => undefined);

        try {
            const config = loadConfig({ MAGICSSO_CONFIG_FILE: configFile.filePath });

            expect(config.cookieSecure).toBe(false);
            expect(emitWarning).toHaveBeenCalledWith(
                expect.stringContaining('cookie.secure=false'),
                expect.objectContaining({ code: 'MAGICSSO_INSECURE_COOKIE' }),
            );
        } finally {
            emitWarning.mockRestore();
            configFile.cleanup();
        }
    });
});

describe('config core helpers', () => {
    it('uses safe OTP defaults and validates enabled OTP configuration', () => {
        const base = `
[auth]
jwtSecret = "jwt-secret-0123456789-0123456789"
csrfSecret = "csrf-secret-0123456789-012345678"
emailSecret = "email-secret-0123456789-01234567"
previewSecret = "preview-secret-0123456789-0123456"

[email]
from = "owner@example.com"

[email.smtp]
host = "smtp.example.com"
user = "smtp-user"
pass = "smtp-password"

[[sites]]
id = "client"
origins = ["http://client.example.com"]
allowedRedirectUris = ["http://client.example.com/verify-email"]
allowedEmails = ["admin@example.com"]
`.trimStart();

        expect(parseMagicSsoConfigToml(base, '/tmp/magic-sso.toml').otp).toEqual({
            allowedAttempts: 3,
            enabled: false,
            expirationSeconds: 300,
            length: 6,
            resendStrategy: 'rotate',
            secret: undefined,
        });
        expect(() =>
            parseMagicSsoConfigToml(
                base.replace(
                    'previewSecret = "preview-secret-0123456789-0123456"',
                    `${'previewSecret = "preview-secret-0123456789-0123456"'}

[auth.otp]
enabled = true`,
                ),
                '/tmp/magic-sso.toml',
            ),
        ).toThrow(/auth\.otp\.secret/u);
        expect(() =>
            parseMagicSsoConfigToml(
                base.replace(
                    'previewSecret = "preview-secret-0123456789-0123456"',
                    `${'previewSecret = "preview-secret-0123456789-0123456"'}

[auth.otp]
enabled = true
secret = "jwt-secret-0123456789-0123456789"
expiration = "16m"`,
                ),
                '/tmp/magic-sso.toml',
            ),
        ).toThrow(/auth\.otp\.expiration/u);
    });

    it('normalizes emails and scopes when building site access rules', () => {
        const accessRules = buildSiteAccessRules(
            createRawSite({
                accessRules: [
                    {
                        email: '  USER@EXAMPLE.COM  ',
                        scopes: [' reports ', 'analytics'],
                    },
                ],
                allowedEmails: ['  ADMIN@EXAMPLE.COM  '],
            }),
        );

        expect(accessRules.get('admin@example.com')).toEqual(new Set([FULL_ACCESS_SCOPE]));
        expect(accessRules.get('user@example.com')).toEqual(new Set(['reports', 'analytics']));
    });

    it('renders deterministic full-access and scoped rules', () => {
        const accessRules = new Map<string, Set<string>>([
            ['viewer@example.com', new Set(['reports', 'analytics'])],
            ['admin@example.com', new Set([FULL_ACCESS_SCOPE])],
        ]);

        expect(renderSiteAccessRules(accessRules)).toEqual({
            accessRules: [
                {
                    email: 'viewer@example.com',
                    scopes: ['analytics', 'reports'],
                },
            ],
            allowedEmails: ['admin@example.com'],
        });
    });

    it('rejects mixed full-access and named-scope grants during render', () => {
        const accessRules = new Map<string, Set<string>>([
            ['admin@example.com', new Set([FULL_ACCESS_SCOPE, 'reports'])],
        ]);

        expect(() => renderSiteAccessRules(accessRules)).toThrowError(
            /full access and named scopes are mixed/u,
        );
    });

    it('round-trips validated TOML config data through stringify', () => {
        const rawConfig = parseMagicSsoTomlConfig(
            `
[auth]
jwtSecret = "jwt-secret-0123456789-0123456789"
csrfSecret = "csrf-secret-0123456789-012345678"
emailSecret = "email-secret-0123456789-01234567"
previewSecret = "preview-secret-0123456789-0123456"

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
allowedEmails = ["admin@example.com"]
            `.trimStart(),
            '/tmp/magic-sso.toml',
        );

        expect(
            parseMagicSsoTomlConfig(
                stringifyMagicSsoTomlConfig(rawConfig),
                '/tmp/magic-sso-roundtrip.toml',
            ),
        ).toEqual(rawConfig);
    });
});
