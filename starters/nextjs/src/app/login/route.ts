// SPDX-License-Identifier: MIT
import { buildLoginUrl } from '@magic-link-sso/nextjs';
import { NextResponse, type NextRequest } from 'next/server';

export function GET(request: NextRequest): NextResponse {
    return NextResponse.redirect(
        buildLoginUrl(request, request.nextUrl.searchParams.get('returnUrl') ?? '/private'),
    );
}
