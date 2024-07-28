// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Wojciech Polak

import type { Routes } from '@angular/router';
import { HomePageComponent } from './home-page.component';
import { LoginPageComponent } from './login-page.component';
import { magicSsoAuthGuard } from './magic-sso';
import { ProtectedPageComponent } from './protected-page.component';

export const routes: Routes = [
    {
        path: '',
        component: HomePageComponent,
        title: 'Magic Link SSO Angular',
    },
    {
        path: 'login',
        component: LoginPageComponent,
        title: 'Sign In | Magic Link SSO Angular',
    },
    {
        path: 'protected',
        canActivate: [magicSsoAuthGuard],
        component: ProtectedPageComponent,
        title: 'Protected | Magic Link SSO Angular',
    },
];
