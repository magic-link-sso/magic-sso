// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Wojciech Polak

import { SignJWT } from 'jose';
import { readFileSync } from 'node:fs';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { AuthPayload } from '../src/types.js';

// Browser suites import the runner-independent sibling directly, without Vitest.
export {
    canonicalFlowUrl,
    runSignInFlowContract,
    signInReturnPaths,
    type SignInFlowDriver,
    type SignInFlowScenario,
    type SignInFlowSession,
} from './sign-in-contract.js';

export interface VerifyAuthTokenContractOptions {
    name: string;
    verify: (
        token: string,
        secret: Uint8Array,
        options: { expectedAudience: string; expectedIssuer?: string },
    ) => Promise<AuthPayload | null>;
}

interface TokenCase {
    name: string;
    accepted: boolean;
    claims?: Record<string, unknown>;
    omit?: string[];
    algorithm?: string;
    signingSecret?: string;
}

interface TokenFixture {
    now: number;
    secret: string;
    payload: Record<string, unknown> & { aud: string; iss: string };
    cases: TokenCase[];
}

// This checked-in JSON fixture is also consumed by the independent Django tests.
const fixture = JSON.parse(
    readFileSync(new URL('./fixtures/access-token-v1.json', import.meta.url), 'utf8'),
) as TokenFixture;

async function signAccessToken(
    testCase: Omit<TokenCase, 'name' | 'accepted'> = {},
): Promise<string> {
    const payload = { ...fixture.payload, ...testCase.claims };
    for (const claim of testCase.omit ?? []) {
        delete payload[claim];
    }
    return new SignJWT(payload)
        .setProtectedHeader({ alg: testCase.algorithm ?? 'HS256' })
        .sign(new TextEncoder().encode(testCase.signingSecret ?? fixture.secret));
}

/** Registers the shared JWT verification contract for an adapter façade. */
export function registerVerifyAuthTokenContract(options: VerifyAuthTokenContractOptions): void {
    const secret = new TextEncoder().encode(fixture.secret);
    const verificationOptions = {
        expectedAudience: fixture.payload.aud,
        expectedIssuer: fixture.payload.iss,
    };

    describe(`${options.name} auth verifier contract`, () => {
        beforeEach(() => vi.setSystemTime(fixture.now * 1000));
        afterEach(() => vi.useRealTimers());

        it.each(fixture.cases)('$name', async (testCase) => {
            const result = await options.verify(
                await signAccessToken(testCase),
                secret,
                verificationOptions,
            );
            if (testCase.accepted) {
                expect(result).toMatchObject({ ...fixture.payload, ...testCase.claims });
            } else {
                expect(result).toBeNull();
            }
        });

        it('fails closed when a caller omits the expected issuer', async () => {
            await expect(
                options.verify(await signAccessToken(), secret, {
                    expectedAudience: fixture.payload.aud,
                }),
            ).resolves.toBeNull();
        });

        it.each(['', 'not-a-jwt'])('rejects malformed token %j', async (token) => {
            await expect(options.verify(token, secret, verificationOptions)).resolves.toBeNull();
        });
    });
}
