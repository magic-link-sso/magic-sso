// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Wojciech Polak

import { type ApplicationConfig } from '@angular/core';
import { provideServerRendering, withRoutes } from '@angular/ssr';
import { serverRoutes } from './app.routes.server';

export const appServerConfig: ApplicationConfig = {
    providers: [provideServerRendering(withRoutes(serverRoutes))],
};
