// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Wojciech Polak

import {
    Component,
    REQUEST,
    computed,
    inject,
    signal,
    ChangeDetectionStrategy,
} from '@angular/core';
import { FormsModule } from '@angular/forms';
import { buildLoginTarget as buildMagicSsoLoginTarget } from '@magic-link-sso/angular';
import { ActivatedRoute } from '@angular/router';
import {
    buildVerifyUrl,
    getAppOrigin,
    getLoginErrorMessage,
    normaliseReturnUrl,
    type SignInResult,
} from './login-utils';
import { MAGIC_SSO_CONFIG } from './magic-sso';

const sharedSigninBadgeUrl = '/assets/signin-page-badge.svg';

@Component({
    imports: [FormsModule],
    standalone: true,
    changeDetection: ChangeDetectionStrategy.Eager,
    template: `
        <main class="login-shell">
            <a class="skip-link" href="#login-panel">Skip to sign-in form</a>
            <section id="login-panel" class="login-panel" aria-labelledby="login-title">
                <img
                    [src]="signinBadgeUrl"
                    alt="Sign-in flow badge"
                    class="badge login-badge"
                    width="144"
                    height="144"
                />
                <p class="eyebrow">Sign In</p>
                <h1 id="login-title" class="login-title">
                    {{ isConfirmation() ? 'Check your email' : 'Sign in' }}
                </h1>
                <p id="signin-help" class="login-copy">
                    @if (isConfirmation()) {
                        If your email can sign in, you will receive a link shortly. Open the email
                        and click the link to continue.
                    } @else {
                        We'll email you a sign-in link.
                    }
                </p>

                @if (!isConfirmation()) {
                    <form
                        class="login-form"
                        aria-describedby="signin-help"
                        ngNativeValidate
                        (ngSubmit)="submitForm()"
                    >
                        <label class="field-label" for="email">Email</label>
                        <input
                            id="email"
                            [(ngModel)]="email"
                            class="field-input"
                            type="email"
                            name="email"
                            autocomplete="email"
                            inputmode="email"
                            placeholder="you@example.com"
                            spellcheck="false"
                            [attr.aria-describedby]="emailDescription()"
                            [attr.aria-invalid]="hasError() ? true : undefined"
                            required
                        />
                        <div class="login-actions">
                            <button
                                class="button button-primary button-submit button-block"
                                type="submit"
                                [attr.aria-disabled]="pending()"
                                [disabled]="pending()"
                            >
                                <span
                                    class="button-spinner"
                                    [class.button-spinner-visible]="pending()"
                                    aria-hidden="true"
                                ></span>
                                <span>{{
                                    pending() ? 'Sending magic link...' : 'Send magic link'
                                }}</span>
                            </button>
                        </div>
                    </form>
                } @else {
                    <div class="confirmation-panel" role="status" aria-live="polite">
                        @if (otpChallengeId() !== null) {
                            <form
                                class="login-form"
                                aria-describedby="otp-help"
                                ngNativeValidate
                                (ngSubmit)="submitOtp()"
                            >
                                <label class="field-label" for="otp-code">One-time code</label>
                                <input
                                    id="otp-code"
                                    [(ngModel)]="otpCode"
                                    class="field-input"
                                    type="text"
                                    name="otpCode"
                                    autocomplete="one-time-code"
                                    inputmode="numeric"
                                    pattern="[0-9]*"
                                    [attr.minlength]="otpLength()"
                                    [attr.maxlength]="otpLength()"
                                    [attr.placeholder]="otpLength() === 6 ? '123456' : undefined"
                                    aria-describedby="otp-help"
                                    required
                                />
                                <p id="otp-help" class="login-copy">
                                    You can also enter the one-time code from the email here.
                                </p>
                                <div class="login-actions">
                                    <button
                                        class="button button-primary button-submit button-block"
                                        type="submit"
                                        [attr.aria-disabled]="pending()"
                                        [disabled]="pending()"
                                    >
                                        <span>Sign in with code</span>
                                    </button>
                                    <button
                                        class="button button-secondary"
                                        type="button"
                                        (click)="useDifferentEmail()"
                                    >
                                        Use a different email
                                    </button>
                                </div>
                            </form>
                        } @else {
                            <div class="login-actions">
                                <button
                                    class="button button-secondary"
                                    type="button"
                                    (click)="useDifferentEmail()"
                                >
                                    Use a different email
                                </button>
                            </div>
                        }
                    </div>
                }
                @if (hasError()) {
                    <p id="signin-feedback" class="message message-error" role="alert">
                        {{ result()?.message }}
                    </p>
                }
            </section>
        </main>
    `,
})
export class LoginPageComponent {
    email = '';
    otpCode = '';
    readonly pending = signal(false);
    readonly result = signal<SignInResult | null>(null);
    readonly signinBadgeUrl = sharedSigninBadgeUrl;
    readonly otpChallengeId = signal<string | null>(null);
    readonly otpLength = signal<number>(6);

    private readonly config = inject(MAGIC_SSO_CONFIG);
    private readonly route = inject(ActivatedRoute);
    private readonly request = inject(REQUEST, { optional: true });
    private readonly appOrigin = getAppOrigin(this.request);
    private readonly returnUrl = normaliseReturnUrl(
        this.route.snapshot.queryParamMap.get('returnUrl') ?? undefined,
        this.appOrigin,
    );
    private readonly scope = this.route.snapshot.queryParamMap.get('scope') ?? undefined;
    private readonly requestedError = this.route.snapshot.queryParamMap.get('error') ?? undefined;
    private readonly verifyUrl = buildVerifyUrl(this.appOrigin, this.returnUrl);
    private readonly loginTarget = buildMagicSsoLoginTarget(
        this.appOrigin,
        this.returnUrl,
        this.config,
        this.scope,
    );

    readonly hasError = computed(() => this.result()?.success === false);
    readonly isConfirmation = computed(
        () => this.result()?.success === true || this.otpChallengeId() !== null,
    );
    readonly emailDescription = computed(() =>
        this.hasError() ? 'signin-help signin-feedback' : 'signin-help',
    );

    constructor() {
        const initialError = getLoginErrorMessage(this.requestedError);
        if (typeof initialError === 'string') {
            this.result.set({
                success: false,
                message: initialError,
            });
        }

        if (
            typeof initialError !== 'string' &&
            typeof window === 'object' &&
            (this.loginTarget.startsWith('http://') || this.loginTarget.startsWith('https://'))
        ) {
            window.location.replace(this.loginTarget);
        }
    }

    async submitForm(): Promise<void> {
        this.pending.set(true);

        try {
            const response = await fetch('/api/signin', {
                method: 'POST',
                headers: {
                    'content-type': 'application/json',
                },
                body: JSON.stringify({
                    email: this.email,
                    returnUrl: this.returnUrl,
                    verifyUrl: this.verifyUrl,
                    scope: this.scope,
                }),
            });

            const payload: unknown = await response.json().catch(() => null);
            const message =
                typeof payload === 'object' &&
                payload !== null &&
                'message' in payload &&
                typeof payload.message === 'string'
                    ? payload.message
                    : undefined;
            if (!response.ok) {
                this.result.set({
                    success: false,
                    message: message ?? 'Failed to send verification email.',
                });
                return;
            }

            this.result.set({
                success: true,
                message: message ?? 'Verification email sent.',
            });
            const otpChallengeId =
                typeof payload === 'object' &&
                payload !== null &&
                'otpChallengeId' in payload &&
                typeof payload.otpChallengeId === 'string'
                    ? payload.otpChallengeId
                    : null;
            const otpLength =
                typeof payload === 'object' &&
                payload !== null &&
                'otpLength' in payload &&
                typeof payload.otpLength === 'number'
                    ? payload.otpLength
                    : 6;
            this.otpChallengeId.set(otpChallengeId);
            this.otpLength.set(otpLength);
        } catch {
            this.result.set({
                success: false,
                message: 'Failed to send verification email.',
            });
        } finally {
            this.pending.set(false);
        }
    }

    async submitOtp(): Promise<void> {
        const challengeId = this.otpChallengeId();
        if (challengeId === null) {
            return;
        }

        this.pending.set(true);
        try {
            const response = await fetch('/api/verify-email/otp', {
                method: 'POST',
                headers: { 'content-type': 'application/json' },
                body: JSON.stringify({
                    challengeId,
                    code: this.otpCode,
                    returnUrl: this.returnUrl,
                }),
            });
            await response.json().catch(() => null);
            if (!response.ok) {
                this.result.set({ success: false, message: 'Invalid or expired code.' });
                return;
            }

            this.otpChallengeId.set(null);
            window.location.assign(this.returnUrl);
        } catch {
            this.result.set({ success: false, message: 'Invalid or expired code.' });
        } finally {
            this.pending.set(false);
        }
    }

    useDifferentEmail(): void {
        this.otpChallengeId.set(null);
        this.otpCode = '';
        this.result.set(null);
    }
}
