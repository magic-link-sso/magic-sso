// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Wojciech Polak

import { provideHttpClient, withFetch } from '@angular/common/http';
import { type ApplicationConfig } from '@angular/core';
import { provideClientHydration } from '@angular/platform-browser';
import { provideRouter } from '@angular/router';
import { provideMagicSso } from './magic-sso';
import { routes } from './app.routes';

export const appConfig: ApplicationConfig = {
    providers: [
        provideClientHydration(),
        provideHttpClient(withFetch()),
        provideRouter(routes),
        provideMagicSso({
            cookieName: 'magic-sso',
            loginPath: '/login',
            sessionEndpoint: '/api/session',
        }),
    ],
};
