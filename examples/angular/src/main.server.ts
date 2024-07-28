// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Wojciech Polak

import { mergeApplicationConfig, type ApplicationConfig, type ApplicationRef } from '@angular/core';
import { bootstrapApplication, type BootstrapContext } from '@angular/platform-browser';
import { AppComponent } from './app/app.component';
import { appConfig } from './app/app.config';
import { appServerConfig } from './app/app.config.server';

const serverConfig: ApplicationConfig = mergeApplicationConfig(appConfig, appServerConfig);

export default function bootstrap(context: BootstrapContext): Promise<ApplicationRef> {
    return bootstrapApplication(AppComponent, serverConfig, context);
}
