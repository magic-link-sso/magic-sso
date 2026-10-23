// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Wojciech Polak

import { beforeEach, describe, expect, it, vi } from 'vitest';

const registration = vi.hoisted(() => {
    const test = Object.assign(vi.fn<(name: string, run: unknown) => void>(), {
        describe: vi.fn((_name: string, register: () => void): void => register()),
        beforeEach: vi.fn(),
    });
    return { test };
});

vi.mock('@playwright/test', () => ({ test: registration.test, expect: vi.fn() }));

import { exampleApps, type ExampleAppDefinition } from './helpers/apps.js';
import { registerSignInFlowSuites } from './helpers/sign-in-contract.js';

const additionalAdapter: ExampleAppDefinition = {
    ...exampleApps[0],
    name: 'additional-adapter',
    displayName: 'Additional adapter',
    appUrl: 'https://additional.example.test',
    protectedPaths: ['/private', '/account'],
};

describe('adapter registration in the existing browser harness', () => {
    beforeEach(() => vi.clearAllMocks());

    it.each(['magic-link', 'otp'] satisfies ('magic-link' | 'otp')[])(
        'registers the full %s contract for an adapter outside the built-in catalog',
        (method) => {
            registerSignInFlowSuites('indirect', method, [additionalAdapter]);

            expect(registration.test.describe.mock.calls.map(([name]) => name)).toEqual([
                `Additional adapter ${method} flow contract (indirect)`,
            ]);
            const names = registration.test.mock.calls.map(([name]) => name);
            expect(names).toHaveLength(4);
            for (const path of additionalAdapter.protectedPaths) {
                expect(names).toContain(`establishes, reuses and clears the session for ${path}`);
                expect(names).toContainEqual(expect.stringContaining(`${path}?status=pending&`));
            }
        },
    );

    it('keeps the existing catalog as the default', () => {
        registerSignInFlowSuites('indirect', 'magic-link');
        expect(registration.test.describe).toHaveBeenCalledTimes(exampleApps.length);
        expect(registration.test).toHaveBeenCalledTimes(
            exampleApps.reduce((count, app) => count + app.protectedPaths.length * 2, 0),
        );
    });
});
