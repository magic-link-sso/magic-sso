// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Wojciech Polak

import { Component, REQUEST, computed, inject, signal } from '@angular/core';
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
                <h1 id="login-title" class="login-title">Sign in</h1>
                <p id="signin-help" class="login-copy">We'll email you a sign-in link.</p>

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
                    @if (result()?.success) {
                        <p
                            id="signin-feedback"
                            class="message message-success"
                            role="status"
                            aria-live="polite"
                        >
                            {{ result()?.message }}
                        </p>
                    }
                    @if (hasError()) {
                        <p id="signin-feedback" class="message message-error" role="alert">
                            {{ result()?.message }}
                        </p>
                    }
                </form>
            </section>
        </main>
    `,
})
export class LoginPageComponent {
    email = '';
    readonly pending = signal(false);
    readonly result = signal<SignInResult | null>(null);
    readonly signinBadgeUrl = sharedSigninBadgeUrl;

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
        } catch {
            this.result.set({
                success: false,
                message: 'Failed to send verification email.',
            });
        } finally {
            this.pending.set(false);
        }
    }
}
