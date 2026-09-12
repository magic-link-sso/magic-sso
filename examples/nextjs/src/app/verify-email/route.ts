// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Wojciech Polak

import { VerifyEmailRoute, type VerifyEmailRouteOptions } from '@magic-link-sso/nextjs';
import type { NextRequest, NextResponse } from 'next/server';

const options: VerifyEmailRouteOptions = {
    pageTitle: 'Confirm Sign In | Magic Link SSO Next.js',
};

export async function GET(request: NextRequest): Promise<NextResponse> {
    return VerifyEmailRoute(request, options);
}

export async function POST(request: NextRequest): Promise<NextResponse> {
    return VerifyEmailRoute(request, options);
}
