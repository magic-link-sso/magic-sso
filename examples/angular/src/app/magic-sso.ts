// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Wojciech Polak

import { HttpClient } from '@angular/common/http';
import {
    Injectable,
    InjectionToken,
    REQUEST,
    TransferState,
    inject,
    makeEnvironmentProviders,
    makeStateKey,
    type EnvironmentProviders,
} from '@angular/core';
import type { CanActivateFn } from '@angular/router';
import { Router } from '@angular/router';
import { firstValueFrom } from 'rxjs';
import {
    buildLoginPath,
    resolveMagicSsoConfig,
    verifyRequestAuth,
    type AuthPayload,
    type MagicSsoConfig,
    type MagicSsoResolvedConfig,
} from '@magic-link-sso/angular';

export type { AuthPayload } from '@magic-link-sso/angular';

const AUTH_STATE_KEY = makeStateKey<AuthPayload | null>('magic-sso-auth');
const CONFIG_STATE_KEY = makeStateKey<MagicSsoResolvedConfig>('magic-sso-config');

function getRequestOrigin(request: Request | null | undefined): string {
    if (request instanceof Request) {
        return new URL(request.url).origin;
    }
    if (typeof location === 'object' && typeof location.origin === 'string') {
        return location.origin;
    }

    return 'http://localhost';
}

function resolveTransferredMagicSsoConfig(config: MagicSsoConfig = {}): MagicSsoResolvedConfig {
    const transferState = inject(TransferState);
    const fallbackConfig = resolveMagicSsoConfig(config);
    if (transferState.hasKey(CONFIG_STATE_KEY)) {
        return transferState.get(CONFIG_STATE_KEY, fallbackConfig);
    }

    transferState.set(CONFIG_STATE_KEY, fallbackConfig);
    return fallbackConfig;
}

export const MAGIC_SSO_CONFIG = new InjectionToken<MagicSsoResolvedConfig>('MAGIC_SSO_CONFIG', {
    providedIn: 'root',
    factory: (): MagicSsoResolvedConfig => resolveTransferredMagicSsoConfig(),
});

export function provideMagicSso(config: MagicSsoConfig = {}): EnvironmentProviders {
    return makeEnvironmentProviders([
        {
            provide: MAGIC_SSO_CONFIG,
            useFactory: (): MagicSsoResolvedConfig => resolveTransferredMagicSsoConfig(config),
        },
    ]);
}

@Injectable({
    providedIn: 'root',
})
export class MagicSsoSessionService {
    private readonly config = inject(MAGIC_SSO_CONFIG);
    private readonly http = inject(HttpClient);
    private readonly request = inject(REQUEST, { optional: true });
    private readonly transferState = inject(TransferState);

    async getAuth(): Promise<AuthPayload | null> {
        if (this.transferState.hasKey(AUTH_STATE_KEY)) {
            return this.transferState.get(AUTH_STATE_KEY, null);
        }

        const auth =
            this.request instanceof Request
                ? await verifyRequestAuth(this.request, this.config)
                : await this.fetchAuth();
        this.transferState.set(AUTH_STATE_KEY, auth);
        return auth;
    }

    async fetchAuth(): Promise<AuthPayload | null> {
        try {
            return await firstValueFrom(
                this.http.get<AuthPayload | null>(this.config.sessionEndpoint, {
                    withCredentials: true,
                }),
            );
        } catch {
            return null;
        }
    }
}

export const magicSsoAuthGuard: CanActivateFn = async (_route, state) => {
    const request = inject(REQUEST, { optional: true });
    const router = inject(Router);
    const session = inject(MagicSsoSessionService);
    const config = inject(MAGIC_SSO_CONFIG);
    const auth = await session.getAuth();

    if (auth !== null) {
        return true;
    }

    return router.parseUrl(buildLoginPath(getRequestOrigin(request), state.url, config));
};
