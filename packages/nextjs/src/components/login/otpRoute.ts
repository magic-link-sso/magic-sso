// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Wojciech Polak

import { NextResponse } from 'next/server';
import { hasSameOriginMutationSource } from '../../lib/auth';
import { verifyEmailOtp } from './actions';

function invalidOtpResponse(status: 400 | 403): NextResponse {
    return NextResponse.json({ message: 'Invalid or expired code.', success: false }, { status });
}

export async function VerifyEmailOtpRoute(request: Request): Promise<NextResponse> {
    if (request.method !== 'POST') {
        return new NextResponse('Method Not Allowed', {
            status: 405,
            headers: { Allow: 'POST' },
        });
    }

    // Cookie issuance changes authentication state, so fail closed when the
    // browser does not prove that the mutation came from this application.
    if (!hasSameOriginMutationSource(request)) {
        return invalidOtpResponse(403);
    }

    const formData = await request.formData().catch(() => null);
    const challengeId = formData?.get('challengeId');
    const code = formData?.get('code');
    if (typeof challengeId !== 'string' || typeof code !== 'string') {
        return invalidOtpResponse(400);
    }

    const result = await verifyEmailOtp(challengeId, code);
    return NextResponse.json(result, { status: result.success ? 200 : 400 });
}
