// SPDX-License-Identifier: MIT

import { describe, expect, it } from 'vitest';
import {
    canonicalFlowUrl,
    runSignInFlowContract,
    signInReturnPaths,
    type SignInFlowDriver,
    type SignInFlowScenario,
    type SignInFlowSession,
} from './adapter-contract.js';

const scenario: SignInFlowScenario = {
    method: 'magic-link',
    appOrigin: 'https://app.example.test',
    email: 'person@example.test',
    siteId: 'app',
    returnPath: signInReturnPaths('/orders')[1] ?? '/orders',
};

function driverFor(
    overrides: Partial<SignInFlowSession> = {},
    behavior: { premature?: boolean; retainAfterLogout?: boolean; rotate?: boolean } = {},
): { driver: SignInFlowDriver; actions: string[] } {
    const actions: string[] = [];
    let authenticated = behavior.premature ?? false;
    let visits = 0;
    const session: SignInFlowSession = {
        url: `${scenario.appOrigin}${scenario.returnPath}`,
        email: scenario.email,
        siteId: scenario.siteId,
        jti: 'session-id',
        httpOnly: true,
        sameSite: 'Lax',
        ...overrides,
    };
    return {
        actions,
        driver: {
            async requestVerification(method, path) {
                actions.push(`request:${method}:${path}`);
                return 'email-proof';
            },
            async hasSession() {
                return authenticated;
            },
            async verify(method, proof) {
                actions.push(`verify:${method}:${proof}`);
                authenticated = true;
            },
            async readSession() {
                return { ...session, jti: behavior.rotate ? String(visits) : session.jti };
            },
            async revisit() {
                visits += 1;
                actions.push('revisit');
            },
            async logout() {
                authenticated = behavior.retainAfterLogout ?? false;
                actions.push('logout');
            },
            async expectSignInRequired() {
                actions.push('protected');
            },
        },
    };
}

describe('complete adapter sign-in contract', () => {
    it('accepts equivalent space encoding while distinguishing literal plus and preserving repeated query parameters', async () => {
        const url = `${scenario.appOrigin}${scenario.returnPath}`;
        expect(canonicalFlowUrl(url)).toBe(canonicalFlowUrl(url.replaceAll('%20', '+')));
        expect(canonicalFlowUrl(url)).not.toBe(canonicalFlowUrl(url.replace('%2B', '+')));
        expect(canonicalFlowUrl(url)).not.toBe(canonicalFlowUrl(url.replace('&tag=two', '')));
        await expect(
            runSignInFlowContract(driverFor({ url: url.replaceAll('%20', '+') }).driver, scenario),
        ).resolves.toBeUndefined();
    });
    const methods: SignInFlowScenario['method'][] = ['magic-link', 'otp'];
    it.each(methods)('uses the same ordered lifecycle for %s', async (method) => {
        const { driver, actions } = driverFor();
        await runSignInFlowContract(driver, { ...scenario, method });
        expect(actions).toEqual([
            `request:${method}:${scenario.returnPath}`,
            `verify:${method}:email-proof`,
            'revisit',
            'logout',
            'protected',
        ]);
    });
    it.each([
        { url: `${scenario.appOrigin}/orders` },
        { email: 'other@example.test' },
        { siteId: 'other-site' },
        { jti: '' },
        { httpOnly: false },
        { sameSite: 'None' },
    ])('rejects an invalid session snapshot %j', async (overrides) => {
        await expect(runSignInFlowContract(driverFor(overrides).driver, scenario)).rejects.toThrow(
            'Sign-in flow contract:',
        );
    });
    it.each([{ premature: true }, { retainAfterLogout: true }, { rotate: true }])(
        'rejects broken lifecycle %j',
        async (behavior) => {
            await expect(
                runSignInFlowContract(driverFor({}, behavior).driver, scenario),
            ).rejects.toThrow('Sign-in flow contract:');
        },
    );
});
