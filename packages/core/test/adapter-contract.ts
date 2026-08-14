// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Wojciech Polak

import { SignJWT } from 'jose';
import { describe, expect, it } from 'vitest';
import type { AuthPayload } from '../src/types.js';
import { authFixture } from './fixtures.js';

export interface VerifyAuthTokenContractOptions {
    name: string;
    verify: (
        token: string,
        secret: Uint8Array,
        options: { expectedAudience: string; expectedIssuer?: string },
    ) => Promise<AuthPayload | null>;
}

async function signAccessToken(options: { audience?: string; issuer?: string }): Promise<string> {
    return new SignJWT({
        email: authFixture.email,
        jti: authFixture.jti,
        scope: authFixture.scope,
        siteId: authFixture.siteId,
    })
        .setProtectedHeader({ alg: 'HS256' })
        .setAudience(options.audience ?? authFixture.audience)
        .setIssuedAt()
        .setExpirationTime('1h')
        .setIssuer(options.issuer ?? authFixture.issuer)
        .sign(new TextEncoder().encode(authFixture.secret));
}

/** Registers the shared JWT verification contract for an adapter façade. */
export function registerVerifyAuthTokenContract(options: VerifyAuthTokenContractOptions): void {
    const secret = new TextEncoder().encode(authFixture.secret);

    describe(`${options.name} auth verifier contract`, () => {
        it('accepts a complete token for the configured issuer and audience', async () => {
            await expect(
                options.verify(await signAccessToken({}), secret, {
                    expectedAudience: authFixture.audience,
                    expectedIssuer: authFixture.issuer,
                }),
            ).resolves.toMatchObject({
                email: authFixture.email,
                jti: authFixture.jti,
                scope: authFixture.scope,
                siteId: authFixture.siteId,
            });
        });

        it('rejects a token for another issuer or audience', async () => {
            await expect(
                options.verify(
                    await signAccessToken({ issuer: 'https://other-sso.example.test' }),
                    secret,
                    {
                        expectedAudience: authFixture.audience,
                        expectedIssuer: authFixture.issuer,
                    },
                ),
            ).resolves.toBeNull();
            await expect(
                options.verify(
                    await signAccessToken({ audience: 'https://other-app.example.test' }),
                    secret,
                    {
                        expectedAudience: authFixture.audience,
                        expectedIssuer: authFixture.issuer,
                    },
                ),
            ).resolves.toBeNull();
        });

        it('fails closed when a caller omits the expected issuer', async () => {
            await expect(
                options.verify(await signAccessToken({}), secret, {
                    expectedAudience: authFixture.audience,
                }),
            ).resolves.toBeNull();
        });
    });
}
