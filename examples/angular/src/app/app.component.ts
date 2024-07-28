// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Wojciech Polak

import { Component } from '@angular/core';
import { RouterOutlet } from '@angular/router';

@Component({
    selector: 'app-root',
    imports: [RouterOutlet],
    standalone: true,
    template: '<router-outlet></router-outlet>',
})
export class AppComponent {}
