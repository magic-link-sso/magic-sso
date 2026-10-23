// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Wojciech Polak

import { verifyAuthTokenWithOptionalIssuer } from '../src/token.js';
import { CompactSign } from 'jose';
import { expect, it } from 'vitest';
import { registerVerifyAuthTokenContract } from './adapter-contract.js';
import { authFixture } from './fixtures.js';

registerVerifyAuthTokenContract({ name: 'Core', verify: verifyAuthTokenWithOptionalIssuer });

it.each(['-1e400', '1e400'])(
    'rejects a not-before value outside the finite range: %s',
    async (nbf) => {
        const { audience, issuer, secret, ...claims } = authFixture;
        // Sign raw JSON to exercise overflow values that SignJWT refuses to produce.
        const payload = JSON.stringify({
            ...claims,
            aud: audience,
            iss: issuer,
            iat: 1609459200,
            exp: 4102444800,
            nbf: 0,
        }).replace('"nbf":0', `"nbf":${nbf}`);
        const key = new TextEncoder().encode(secret);
        const token = await new CompactSign(new TextEncoder().encode(payload))
            .setProtectedHeader({ alg: 'HS256' })
            .sign(key);

        await expect(
            verifyAuthTokenWithOptionalIssuer(token, key, {
                expectedAudience: audience,
                expectedIssuer: issuer,
            }),
        ).resolves.toBeNull();
    },
);
