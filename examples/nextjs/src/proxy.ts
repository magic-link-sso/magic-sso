// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Wojciech Polak
// src/proxy.ts

import { authMiddleware } from '@magic-link-sso/nextjs';

export default authMiddleware;

// Apply auth to all routes except the explicitly public ones.
export const config = {
    matcher: ['/((?!login|logout|verify-email|api/signin|public|_next|favicon.ico).+)'],
};
