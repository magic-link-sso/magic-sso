// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Wojciech Polak

import { VerifyEmailOtpRoute } from '@magic-link-sso/nextjs';
import { NextRequest, NextResponse } from 'next/server';

export async function POST(request: NextRequest): Promise<NextResponse> {
    return VerifyEmailOtpRoute(request);
}
