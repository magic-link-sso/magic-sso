// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Wojciech Polak

import { VerifyEmailRoute, type VerifyEmailRouteOptions } from '@magic-link-sso/nextjs';
import type { NextRequest, NextResponse } from 'next/server';
import { resolveRequestAppOrigin } from '../login/url';

const options: VerifyEmailRouteOptions = {
    pageTitle: 'Confirm Sign In | Magic Link SSO Photos Demo',
    resolveAppOrigin: resolveRequestAppOrigin,
};

export async function GET(request: NextRequest): Promise<NextResponse> {
    return VerifyEmailRoute(request, options);
}

export async function POST(request: NextRequest): Promise<NextResponse> {
    return VerifyEmailRoute(request, options);
}
