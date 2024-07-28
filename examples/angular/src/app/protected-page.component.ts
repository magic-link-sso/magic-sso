// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Wojciech Polak

import { Component, inject, signal } from '@angular/core';
import { MagicSsoSessionService, type AuthPayload } from './magic-sso';

const sharedProtectedBadgeUrl = '/assets/protected-page-badge.svg';

@Component({
    standalone: true,
    template: `
        <main class="shell">
            <div class="card hero">
                <div class="hero-top">
                    <img
                        [src]="protectedBadgeUrl"
                        alt="Protected area badge"
                        class="badge"
                        width="144"
                        height="144"
                    />
                    <div>
                        <p class="eyebrow">Protected Space</p>
                        <h1 class="title">Your Angular session is locked in and verified.</h1>
                        <p class="copy">
                            Hello,
                            <strong>{{ auth()?.email ?? 'friend' }}</strong
                            >. This page is available only after a valid Magic Link SSO token is
                            confirmed.
                        </p>
                    </div>
                </div>

                <div class="meta-row">
                    <section class="panel panel-dark">
                        <p class="panel-title">Protected Route</p>
                        <p class="panel-copy">
                            This page uses the reusable
                            <code>magicSsoAuthGuard</code> and the
                            <code>MagicSsoSessionService</code>.
                        </p>
                    </section>
                    <section class="panel">
                        <p class="panel-title">Next Steps</p>
                        <div class="actions">
                            <a href="/" class="button button-primary">Back Home</a>
                            <form action="/logout" method="post">
                                <button class="button button-secondary" type="submit">
                                    Logout
                                </button>
                            </form>
                        </div>
                    </section>
                </div>
            </div>
        </main>
    `,
})
export class ProtectedPageComponent {
    readonly auth = signal<AuthPayload | null>(null);
    readonly protectedBadgeUrl = sharedProtectedBadgeUrl;

    private readonly session = inject(MagicSsoSessionService);

    constructor() {
        void this.loadAuth();
    }

    private async loadAuth(): Promise<void> {
        this.auth.set(await this.session.getAuth());
    }
}
