/**
 * server/src/securityState.test.ts
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

import { describe, expect, it, vi } from 'vitest';
import {
    createDefaultHostedAuthBranding,
    createDefaultHostedAuthPageCopy,
    type AppConfig,
} from './config.js';
import { FULL_ACCESS_SCOPE } from './scope.js';
import { createSecurityState } from './securityState.js';
import type { RedisSecurityStateClient } from './redisSecurityState.js';

function createConfig(): AppConfig {
    const hostedAuthBranding = createDefaultHostedAuthBranding();
    const hostedAuthPageCopy = createDefaultHostedAuthPageCopy();

    return {
        appPort: 3000,
        appUrl: 'http://sso.example.com',
        csrfSecret: 'csrf-secret',
        cookieDomain: undefined,
        cookieHttpOnly: true,
        cookieName: 'magic-sso',
        cookiePath: undefined,
        cookieSameSite: 'lax',
        cookieSecure: false,
        emailExpirationSeconds: 15 * 60,
        emailFrom: 'owner@example.com',
        emailSecret: 'email-secret',
        emailSignature: 'Magic Link SSO',
        emailSmtpHost: 'smtp.example.com',
        emailSmtpPort: 587,
        emailSmtpPass: 'smtp-password',
        emailSmtpSecure: false,
        emailSmtpUser: 'smtp-user',
        emailSmtpFallbacks: [],
        healthzRateLimitMax: 60,
        hostedAuthBranding,
        hostedAuthPageCopy,
        jwtExpirationSeconds: 60 * 60,
        jwtSecret: 'jwt-secret',
        logFormat: 'json',
        logLevel: 'info',
        rateLimitWindowMs: 60_000,
        securityState: {
            adapter: 'redis',
            keyPrefix: 'magic-sso-test',
            redisUrl: 'redis://127.0.0.1:6379/0',
        },
        serveRootLandingPage: true,
        previewSecret: 'preview-secret',
        signInEmailRateLimitMax: 5,
        signInEmailRateLimitStoreDir: '.magic-sso/test-signin-email-rate-limit',
        signInPageRateLimitMax: 30,
        signInRateLimitMax: 20,
        sites: [
            {
                id: 'client',
                origins: new Set(['http://client.example.com']),
                allowedRedirectUris: [
                    {
                        match: 'subpath',
                        origin: 'http://client.example.com',
                        pathname: '/',
                    },
                ],
                accessRules: new Map([['allowed@example.com', new Set([FULL_ACCESS_SCOPE])]]),
                hostedAuthBranding,
                hostedAuthPageCopy,
            },
        ],
        trustProxy: false,
        verifyRateLimitMax: 40,
        verifyTokenStoreDir: '.magic-sso/test-verification-tokens',
    };
}

describe('createSecurityState', () => {
    it('connects and closes the shared Redis security state client', async () => {
        const connect = vi.fn(async (): Promise<void> => undefined);
        const ping = vi.fn(async (): Promise<string> => 'PONG');
        const quit = vi.fn(async (): Promise<string> => 'OK');
        const client: RedisSecurityStateClient = {
            connect,
            disconnect: vi.fn(),
            eval: vi.fn(async (): Promise<unknown> => [1, 0]),
            get: vi.fn(async (): Promise<null> => null),
            ping,
            quit,
            set: vi.fn(async (): Promise<'OK'> => 'OK'),
        };

        const securityState = await createSecurityState(createConfig(), {
            createRedisClient: () => client,
        });

        try {
            await expect(
                securityState.verificationTokenReplayStore.consume(
                    'token-jti',
                    Date.now() + 60_000,
                ),
            ).resolves.toBe(true);
            await expect(
                securityState.perEmailSignInLimiter.consume('allowed@example.com', '127.0.0.1'),
            ).resolves.toEqual({
                allowed: true,
                retryAfterSeconds: 0,
            });
            await expect(
                securityState.sessionRevocationStore.isRevoked('session-jti'),
            ).resolves.toBe(false);
            expect(connect).toHaveBeenCalledOnce();
            expect(ping).toHaveBeenCalledOnce();
        } finally {
            await securityState.close();
        }

        expect(quit).toHaveBeenCalledOnce();
    });

    it('disconnects the Redis client when startup verification fails', async () => {
        const disconnect = vi.fn(() => undefined);
        const client: RedisSecurityStateClient = {
            connect: vi.fn(async (): Promise<void> => undefined),
            disconnect,
            eval: vi.fn(async (): Promise<unknown> => [1, 0]),
            get: vi.fn(async (): Promise<null> => null),
            ping: vi.fn(async (): Promise<string> => {
                throw new Error('Redis unavailable');
            }),
            quit: vi.fn(async (): Promise<string> => 'OK'),
            set: vi.fn(async (): Promise<'OK'> => 'OK'),
        };

        await expect(
            createSecurityState(createConfig(), {
                createRedisClient: () => client,
            }),
        ).rejects.toThrow('Redis unavailable');
        expect(disconnect).toHaveBeenCalledOnce();
    });
});
