// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Wojciech Polak

import { verifyToken } from '@magic-link-sso/nextjs';
import type { ViewerSession } from './access';

export async function readViewer(): Promise<ViewerSession> {
    return verifyToken();
}
