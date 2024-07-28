/**
 * server/src/securityState.ts
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

import type { AppConfig } from './config.js';
import { join } from 'node:path';
import {
    createFilePerEmailSignInLimiter,
    type PerEmailSignInLimiter,
} from './perEmailSignInLimiter.js';
import {
    createRedisPerEmailSignInLimiter,
    createRedisSessionRevocationStore,
    createRedisSecurityStateClient,
    createRedisVerificationTokenReplayStore,
    type RedisSecurityStateClient,
} from './redisSecurityState.js';
import {
    createFileSessionRevocationStore,
    type SessionRevocationStore,
} from './sessionRevocationStore.js';
import {
    createFileVerificationTokenReplayStore,
    type VerificationTokenReplayStore,
} from './verificationTokenReplayStore.js';

export interface SharedSecurityState {
    close(): Promise<void>;
    perEmailSignInLimiter: PerEmailSignInLimiter;
    sessionRevocationStore: SessionRevocationStore;
    verificationTokenReplayStore: VerificationTokenReplayStore;
}

interface CreateSecurityStateDependencies {
    createRedisClient?: (redisUrl: string) => RedisSecurityStateClient;
}

export async function createSecurityState(
    config: AppConfig,
    dependencies: CreateSecurityStateDependencies = {},
): Promise<SharedSecurityState> {
    if (config.securityState.adapter === 'redis') {
        const createRedisClient = dependencies.createRedisClient ?? createRedisSecurityStateClient;
        const redisUrl = config.securityState.redisUrl;
        if (typeof redisUrl !== 'string') {
            throw new Error(
                'server.securityState.redisUrl must be configured when server.securityState.adapter = "redis".',
            );
        }

        const client = createRedisClient(redisUrl);
        try {
            await client.connect();
            await client.ping();
        } catch (error) {
            client.disconnect();
            throw error;
        }

        return {
            close: async (): Promise<void> => {
                await client.quit();
            },
            perEmailSignInLimiter: createRedisPerEmailSignInLimiter({
                client,
                keyPrefix: config.securityState.keyPrefix,
                rateLimitWindowMs: config.rateLimitWindowMs,
                signInEmailRateLimitMax: config.signInEmailRateLimitMax,
            }),
            sessionRevocationStore: createRedisSessionRevocationStore({
                client,
                keyPrefix: config.securityState.keyPrefix,
            }),
            verificationTokenReplayStore: createRedisVerificationTokenReplayStore({
                client,
                keyPrefix: config.securityState.keyPrefix,
            }),
        };
    }

    const verificationTokenReplayStore = await createFileVerificationTokenReplayStore({
        directory: config.verifyTokenStoreDir,
    });
    const perEmailSignInLimiter = await createFilePerEmailSignInLimiter({
        directory: config.signInEmailRateLimitStoreDir,
        rateLimitWindowMs: config.rateLimitWindowMs,
        signInEmailRateLimitMax: config.signInEmailRateLimitMax,
    });
    const sessionRevocationStore = await createFileSessionRevocationStore({
        directory: join(config.verifyTokenStoreDir, 'sessions'),
    });

    return {
        close: async (): Promise<void> => undefined,
        perEmailSignInLimiter,
        sessionRevocationStore,
        verificationTokenReplayStore,
    };
}
