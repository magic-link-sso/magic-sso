// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Wojciech Polak

import { Component, inject, signal } from '@angular/core';
import { REQUEST } from '@angular/core';
import { buildLoginTarget as buildMagicSsoLoginTarget } from '@magic-link-sso/angular';
import { getAppOrigin } from './login-utils';
import { MAGIC_SSO_CONFIG, MagicSsoSessionService, type AuthPayload } from './magic-sso';

const sharedSigninBadgeUrl = '/assets/signin-page-badge.svg';

@Component({
    standalone: true,
    template: `
        <main class="shell">
            <div class="card hero">
                <div class="hero-top">
                    <img
                        [src]="signinBadgeUrl"
                        alt="Sign-in flow badge"
                        class="badge"
                        width="144"
                        height="144"
                    />
                    <div>
                        <p class="eyebrow">Magic Link SSO</p>
                        <h1 class="title">Angular 21 SSR demo app for Magic Link sign-in.</h1>
                        <p class="copy">
                            Start the sign-in flow here, then open a protected route once your
                            session cookie is active.
                        </p>
                    </div>
                </div>

                <div class="grid">
                    <section class="panel">
                        <p class="panel-title">Session Status</p>
                        @if (auth(); as user) {
                            <p class="panel-copy">
                                Signed in as <strong>{{ user.email }}</strong
                                >. Your token is already active for protected routes.
                            </p>
                        } @else {
                            <p class="panel-copy">
                                You are not signed in yet. Start with the login page, then come back
                                here to see the authenticated state.
                            </p>
                        }
                    </section>

                    <section class="panel panel-dark">
                        <p class="panel-title">Quick Actions</p>
                        <div class="actions">
                            @if (auth()) {
                                <a href="/protected" class="button button-light"
                                    >Open Protected Page</a
                                >
                                <form action="/logout" method="post">
                                    <button class="button button-secondary" type="submit">
                                        Logout
                                    </button>
                                </form>
                            } @else {
                                <a [href]="loginTarget()" class="button button-light">Login</a>
                                <a href="/protected" class="button button-secondary"
                                    >Try Protected Page</a
                                >
                            }
                        </div>
                    </section>
                </div>
            </div>
        </main>
    `,
})
export class HomePageComponent {
    readonly auth = signal<AuthPayload | null>(null);
    readonly loginTarget = signal<string>('/login');
    readonly signinBadgeUrl = sharedSigninBadgeUrl;

    private readonly config = inject(MAGIC_SSO_CONFIG);
    private readonly request = inject(REQUEST, { optional: true });
    private readonly session = inject(MagicSsoSessionService);

    constructor() {
        const appOrigin = getAppOrigin(this.request);
        this.loginTarget.set(buildMagicSsoLoginTarget(appOrigin, '/', this.config));
        void this.loadAuth();
    }

    private async loadAuth(): Promise<void> {
        this.auth.set(await this.session.getAuth());
    }
}
