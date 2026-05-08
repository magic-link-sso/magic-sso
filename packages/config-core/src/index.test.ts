import { describe, expect, it } from 'vitest';
import {
    FULL_ACCESS_SCOPE,
    buildSiteAccessRules,
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

describe('config core helpers', () => {
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
