// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 Wojciech Polak

import type { ManagerRuntimeSettings } from '../settings.js';

export interface ManagerRouteContext {
    settings: ManagerRuntimeSettings;
    fetchImplementation?: typeof fetch | undefined;
    now?: Date | undefined;
}
