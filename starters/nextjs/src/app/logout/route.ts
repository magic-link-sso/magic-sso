// SPDX-License-Identifier: MIT
import { LogoutRoute } from '@magic-link-sso/nextjs';
import type { NextRequest } from 'next/server';

export async function POST(request: NextRequest): Promise<Response> {
    return LogoutRoute(request);
}
