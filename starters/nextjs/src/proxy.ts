// SPDX-License-Identifier: MIT
import { authMiddleware } from '@magic-link-sso/nextjs';
import type { NextRequest, NextResponse } from 'next/server';

export default function proxy(request: NextRequest): Promise<NextResponse> {
    return authMiddleware(request);
}

export const config = { matcher: ['/private/:path*'] };
