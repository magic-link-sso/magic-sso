// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Wojciech Polak

import { SignJWT } from 'jose';
import { afterEach, describe, expect, it } from 'vitest';
import {
    DEFAULT_EXCLUDED_PATHS,
    buildLoginUrl,
    getExcludedPaths,
    getMagicSsoConfig,
    getJwtSecret,
    isPublicPath,
    normaliseReturnUrl,
    resolveMagicSsoConfig,
    verifyAuthToken,
    verifyRequestAuth,
} from './auth';

async function signToken(
    email: string,
    secret: string,
    audience: string,
    issuer: string,
): Promise<string> {
    return new SignJWT({ email, scope: '*', siteId: 'site-a' })
        .setProtectedHeader({ alg: 'HS256' })
        .setAudience(audience)
        .setExpirationTime('1h')
        .setIssuer(issuer)
        .sign(new TextEncoder().encode(secret));
}

function createEvent(origin: string): {
    node: { req: { headers: Record<string, string> } };
    context?: { nitro?: { runtimeConfig?: { magicSso?: Record<string, unknown> } } };
    path: string;
} {
    const url = new URL(origin);

    return {
        node: {
            req: {
                headers: {
                    host: url.host,
                },
            },
        },
        path: url.pathname,
    };
}

describe('resolveMagicSsoConfig', () => {
    it('uses strict defaults when config is missing', () => {
        expect(resolveMagicSsoConfig(undefined)).toEqual({
            previewSecret: '',
            serverUrl: '',
            jwtSecret: '',
            cookieName: 'token',
            cookiePath: '/',
            cookieMaxAge: undefined,
            directUse: false,
            publicOrigin: '',
            trustProxy: false,
            excludedPaths: DEFAULT_EXCLUDED_PATHS,
            authEverywhere: false,
        });
    });

    it('normalizes caller-provided values', () => {
        expect(
            resolveMagicSsoConfig({
                previewSecret: 'preview-secret',
                serverUrl: 'http://localhost:3000',
                jwtSecret: 'secret',
                cookieName: 'magic-sso',
                cookiePath: '/auth',
                cookieMaxAge: '3600',
                directUse: true,
                publicOrigin: 'https://app.example.com/path?q=1',
                trustProxy: true,
                excludedPaths: ['/healthz'],
                authEverywhere: true,
            }),
        ).toEqual({
            previewSecret: 'preview-secret',
            serverUrl: 'http://localhost:3000',
            jwtSecret: 'secret',
            cookieName: 'magic-sso',
            cookiePath: '/auth',
            cookieMaxAge: 3600,
            directUse: true,
            publicOrigin: 'https://app.example.com',
            trustProxy: true,
            excludedPaths: ['/healthz'],
            authEverywhere: true,
        });
    });

    it('rejects invalid cookie paths', () => {
        expect(() =>
            resolveMagicSsoConfig({
                cookiePath: 'auth',
            }),
        ).toThrowError('MAGICSSO_COOKIE_PATH must start with "/".');
    });
});

describe('getMagicSsoConfig', () => {
    const originalAppUrl = process.env.APP_URL;
    const originalDirectUse = process.env.MAGICSSO_DIRECT_USE;
    const originalCookiePath = process.env.MAGICSSO_COOKIE_PATH;
    const originalJwtSecret = process.env.JWT_SECRET;
    const originalCookieName = process.env.COOKIE_NAME;
    const originalCookieMaxAge = process.env.MAGICSSO_COOKIE_MAX_AGE;
    const originalPublicOrigin = process.env.MAGICSSO_PUBLIC_ORIGIN;
    const originalTrustProxy = process.env.MAGICSSO_TRUST_PROXY;

    afterEach(() => {
        if (typeof originalAppUrl === 'string') {
            process.env.APP_URL = originalAppUrl;
        } else {
            delete process.env.APP_URL;
        }
        if (typeof originalDirectUse === 'string') {
            process.env.MAGICSSO_DIRECT_USE = originalDirectUse;
        } else {
            delete process.env.MAGICSSO_DIRECT_USE;
        }
        if (typeof originalCookiePath === 'string') {
            process.env.MAGICSSO_COOKIE_PATH = originalCookiePath;
        } else {
            delete process.env.MAGICSSO_COOKIE_PATH;
        }
        if (typeof originalJwtSecret === 'string') {
            process.env.JWT_SECRET = originalJwtSecret;
        } else {
            delete process.env.JWT_SECRET;
        }
        if (typeof originalCookieName === 'string') {
            process.env.COOKIE_NAME = originalCookieName;
        } else {
            delete process.env.COOKIE_NAME;
        }
        if (typeof originalCookieMaxAge === 'string') {
            process.env.MAGICSSO_COOKIE_MAX_AGE = originalCookieMaxAge;
        } else {
            delete process.env.MAGICSSO_COOKIE_MAX_AGE;
        }
        if (typeof originalPublicOrigin === 'string') {
            process.env.MAGICSSO_PUBLIC_ORIGIN = originalPublicOrigin;
        } else {
            delete process.env.MAGICSSO_PUBLIC_ORIGIN;
        }
        if (typeof originalTrustProxy === 'string') {
            process.env.MAGICSSO_TRUST_PROXY = originalTrustProxy;
        } else {
            delete process.env.MAGICSSO_TRUST_PROXY;
        }
    });

    it('falls back to shared server env values when runtime config is missing', () => {
        process.env.APP_URL = 'http://localhost:3000';
        process.env.MAGICSSO_COOKIE_PATH = '/auth';
        process.env.JWT_SECRET = 'shared-secret';
        process.env.COOKIE_NAME = 'magic-sso';
        process.env.MAGICSSO_COOKIE_MAX_AGE = '3600';

        const event = {
            ...createEvent('http://app.example.com/protected'),
            context: {
                nitro: {},
            },
        };

        expect(getMagicSsoConfig(event)).toMatchObject({
            serverUrl: 'http://localhost:3000',
            jwtSecret: 'shared-secret',
            cookieName: 'magic-sso',
            cookiePath: '/auth',
            cookieMaxAge: 3600,
            publicOrigin: '',
            trustProxy: false,
        });
    });

    it('reads public origin and trust proxy from env when runtime config is missing', () => {
        process.env.APP_URL = 'http://localhost:3000';
        process.env.MAGICSSO_PUBLIC_ORIGIN = 'https://app.example.com/path?q=1';
        process.env.MAGICSSO_TRUST_PROXY = 'true';

        const event = {
            ...createEvent('http://app.example.com/protected'),
            context: {
                nitro: {},
            },
        };

        expect(getMagicSsoConfig(event)).toMatchObject({
            publicOrigin: 'https://app.example.com',
            trustProxy: true,
        });
    });

    it('treats MAGICSSO_DIRECT_USE=true as enabling direct use', () => {
        process.env.APP_URL = 'http://localhost:3000';
        process.env.MAGICSSO_DIRECT_USE = 'true';

        const event = {
            ...createEvent('http://app.example.com/protected'),
            context: {
                nitro: {},
            },
        };

        expect(getMagicSsoConfig(event).directUse).toBe(true);
    });

    it('treats MAGICSSO_DIRECT_USE=1 as enabling direct use', () => {
        process.env.APP_URL = 'http://localhost:3000';
        process.env.MAGICSSO_DIRECT_USE = '1';

        const event = {
            ...createEvent('http://app.example.com/protected'),
            context: {
                nitro: {},
            },
        };

        expect(getMagicSsoConfig(event).directUse).toBe(true);
    });

    it('treats MAGICSSO_DIRECT_USE=false as disabling direct use', () => {
        process.env.APP_URL = 'http://localhost:3000';
        process.env.MAGICSSO_DIRECT_USE = 'false';

        const event = {
            ...createEvent('http://app.example.com/protected'),
            context: {
                nitro: {},
            },
        };

        expect(getMagicSsoConfig(event).directUse).toBe(false);
    });

    it('treats MAGICSSO_DIRECT_USE=0 as disabling direct use', () => {
        process.env.APP_URL = 'http://localhost:3000';
        process.env.MAGICSSO_DIRECT_USE = '0';

        const event = {
            ...createEvent('http://app.example.com/protected'),
            context: {
                nitro: {},
            },
        };

        expect(getMagicSsoConfig(event).directUse).toBe(false);
    });
});

describe('getJwtSecret', () => {
    it('returns null when the secret is empty', () => {
        expect(
            getJwtSecret({
                jwtSecret: '',
            }),
        ).toBeNull();
    });
});

describe('public path helpers', () => {
    it('uses the default public routes', () => {
        expect(getExcludedPaths()).toEqual(DEFAULT_EXCLUDED_PATHS);
        expect(isPublicPath('/')).toBe(true);
        expect(isPublicPath('/login')).toBe(true);
        expect(isPublicPath('/_nuxt/build.js')).toBe(true);
        expect(isPublicPath('/protected')).toBe(false);
    });

    it('respects configured exclusions', () => {
        const options = {
            excludedPaths: ['/healthz', '/docs'],
        };

        expect(getExcludedPaths(options)).toEqual(['/healthz', '/docs']);
        expect(isPublicPath('/docs/getting-started', options)).toBe(true);
        expect(isPublicPath('/private', options)).toBe(false);
    });
});

describe('buildLoginUrl', () => {
    it('builds a local login URL by default', () => {
        const event = {
            ...createEvent('http://app.example.com/protected'),
            context: {
                nitro: {
                    runtimeConfig: {
                        magicSso: {
                            directUse: false,
                            serverUrl: 'http://sso.example.com',
                        },
                    },
                },
            },
        };

        expect(buildLoginUrl(event, '/protected')).toBe(
            '/login?returnUrl=http%3A%2F%2Fapp.example.com%2Fprotected',
        );
    });

    it('includes scope in the local login URL when provided', () => {
        const event = {
            ...createEvent('http://app.example.com/protected'),
            context: {
                nitro: {
                    runtimeConfig: {
                        magicSso: {
                            directUse: false,
                            serverUrl: 'http://sso.example.com',
                        },
                    },
                },
            },
        };

        expect(buildLoginUrl(event, '/protected', 'album-A')).toBe(
            '/login?returnUrl=http%3A%2F%2Fapp.example.com%2Fprotected&scope=album-A',
        );
    });

    it('builds a direct SSO URL when configured', () => {
        const event = {
            ...createEvent('http://app.example.com/protected'),
            context: {
                nitro: {
                    runtimeConfig: {
                        magicSso: {
                            directUse: true,
                            serverUrl: 'http://sso.example.com',
                        },
                    },
                },
            },
        };

        const loginUrl = new URL(buildLoginUrl(event, '/protected'));

        expect(loginUrl.origin).toBe('http://sso.example.com');
        expect(loginUrl.pathname).toBe('/signin');
        expect(loginUrl.searchParams.get('returnUrl')).toBe('http://app.example.com/protected');
        expect(loginUrl.searchParams.get('verifyUrl')).toBe(
            'http://app.example.com/verify-email?returnUrl=http%3A%2F%2Fapp.example.com%2Fprotected',
        );
    });

    it('includes scope in the direct SSO URL when provided', () => {
        const event = {
            ...createEvent('http://app.example.com/protected'),
            context: {
                nitro: {
                    runtimeConfig: {
                        magicSso: {
                            directUse: true,
                            serverUrl: 'http://sso.example.com',
                        },
                    },
                },
            },
        };

        const loginUrl = new URL(buildLoginUrl(event, '/protected', 'album-A'));

        expect(loginUrl.origin).toBe('http://sso.example.com');
        expect(loginUrl.pathname).toBe('/signin');
        expect(loginUrl.searchParams.get('returnUrl')).toBe('http://app.example.com/protected');
        expect(loginUrl.searchParams.get('scope')).toBe('album-A');
        expect(loginUrl.searchParams.get('verifyUrl')).toBe(
            'http://app.example.com/verify-email?returnUrl=http%3A%2F%2Fapp.example.com%2Fprotected',
        );
    });
});

describe('normaliseReturnUrl', () => {
    it('allows same-origin absolute URLs', () => {
        expect(
            normaliseReturnUrl('http://app.example.com/protected', 'http://app.example.com'),
        ).toBe('http://app.example.com/protected');
    });

    it('allows safe local paths and rejects unsafe values', () => {
        expect(normaliseReturnUrl('/protected', 'http://app.example.com')).toBe('/protected');
        expect(normaliseReturnUrl('http://evil.example.com', 'http://app.example.com')).toBe('/');
        expect(normaliseReturnUrl(undefined, 'http://app.example.com')).toBe('/');
    });
});

describe('verifyAuthToken', () => {
    it('returns the decoded payload for valid tokens', async () => {
        const token = await signToken(
            'user@example.com',
            'test-secret',
            'http://app.example.com',
            'http://sso.example.com',
        );

        await expect(
            verifyAuthToken(token, new TextEncoder().encode('test-secret'), {
                expectedAudience: 'http://app.example.com',
                expectedIssuer: 'http://sso.example.com',
            }),
        ).resolves.toMatchObject({
            email: 'user@example.com',
            scope: '*',
            siteId: 'site-a',
        });
    });

    it('returns null for invalid tokens', async () => {
        await expect(
            verifyAuthToken('invalid-token', new TextEncoder().encode('test-secret'), {
                expectedAudience: 'http://app.example.com',
                expectedIssuer: 'http://sso.example.com',
            }),
        ).resolves.toBeNull();
    });

    it('returns null when the token audience does not match the app origin', async () => {
        const token = await signToken(
            'user@example.com',
            'test-secret',
            'http://app.example.com',
            'http://sso.example.com',
        );

        await expect(
            verifyAuthToken(token, new TextEncoder().encode('test-secret'), {
                expectedAudience: 'http://admin.example.com',
                expectedIssuer: 'http://sso.example.com',
            }),
        ).resolves.toBeNull();
    });
});

describe('verifyRequestAuth', () => {
    it('uses the configured public origin for audience checks', async () => {
        const token = await signToken(
            'user@example.com',
            'test-secret',
            'https://app.example.com',
            'http://sso.example.com',
        );
        const event = {
            ...createEvent('http://internal.example.local/protected'),
            context: {
                nitro: {
                    runtimeConfig: {
                        magicSso: {
                            jwtSecret: 'test-secret',
                            serverUrl: 'http://sso.example.com',
                            cookieName: 'token',
                            publicOrigin: 'https://app.example.com',
                            trustProxy: false,
                        },
                    },
                },
            },
        };
        event.node.req.headers['cookie'] = `token=${token}`;

        await expect(verifyRequestAuth(event)).resolves.toMatchObject({
            email: 'user@example.com',
        });
    });

    it('rejects requests when no public origin is configured and trust proxy is disabled', async () => {
        const token = await signToken(
            'user@example.com',
            'test-secret',
            'http://app.example.com',
            'http://sso.example.com',
        );
        const event = {
            ...createEvent('http://app.example.com/protected'),
            context: {
                nitro: {
                    runtimeConfig: {
                        magicSso: {
                            jwtSecret: 'test-secret',
                            serverUrl: 'http://sso.example.com',
                            cookieName: 'token',
                            trustProxy: false,
                        },
                    },
                },
            },
        };
        event.node.req.headers['cookie'] = `token=${token}`;

        await expect(verifyRequestAuth(event)).resolves.toBeNull();
    });
});
