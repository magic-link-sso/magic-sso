import { test } from '@playwright/test';
import { clearMailbox } from './helpers/mail-sink.js';
import { type FlowMode } from './helpers/magic-link-flow.js';
import { registerSignInFlowSuites } from './helpers/sign-in-contract.js';

export function registerEmailOtpSuites(flowMode: FlowMode): void {
    test.beforeEach(async ({ request }) => {
        await clearMailbox(request);
    });
    registerSignInFlowSuites(flowMode, 'otp');
}
