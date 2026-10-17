// SPDX-License-Identifier: MIT
import { VerifyEmailRoute } from '@magic-link-sso/nextjs';
import type { NextRequest, NextResponse } from 'next/server';

export async function GET(request: NextRequest): Promise<NextResponse> {
    return VerifyEmailRoute(request);
}

export async function POST(request: NextRequest): Promise<NextResponse> {
    return VerifyEmailRoute(request);
}
