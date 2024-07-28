// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Wojciech Polak

import { RenderMode, type ServerRoute } from '@angular/ssr';

export const serverRoutes: ServerRoute[] = [
    {
        path: '**',
        renderMode: RenderMode.Server,
    },
];
