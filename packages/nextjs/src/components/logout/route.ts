/**
 * packages/nextjs/src/components/logout/route.ts
 *
 * @license MIT
 *
 * MIT License
 *
 * Magic Link SSO Copyright (C) 2026 Wojciech Polak
 *
 * Permission is hereby granted, free of charge, to any person obtaining a copy
 * of this software and associated documentation files (the "Software"), to deal
 * in the Software without restriction, including without limitation the rights
 * to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
 * copies of the Software, and to permit persons to whom the Software is
 * furnished to do so, subject to the following conditions:
 *
 * The above copyright notice and this permission notice shall be included in
 * all copies or substantial portions of the Software.
 *
 * THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
 * IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
 * FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
 * AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
 * LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
 * OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN
 * THE SOFTWARE.
 */

import { NextResponse } from 'next/server';
import { getCookieName, getCookiePath } from '../../lib/auth';

function hasSameOriginMutationSource(request: Request): boolean {
    const expectedOrigin = new URL(request.url).origin;
    const originHeader = request.headers.get('origin');
    if (typeof originHeader === 'string' && originHeader.length > 0) {
        return originHeader === expectedOrigin;
    }

    const refererHeader = request.headers.get('referer');
    if (typeof refererHeader !== 'string' || refererHeader.length === 0) {
        return false;
    }

    try {
        return new URL(refererHeader).origin === expectedOrigin;
    } catch {
        return false;
    }
}

export async function LogoutRoute(request: Request): Promise<Response> {
    if (request.method !== 'POST') {
        return new NextResponse('Method Not Allowed', {
            status: 405,
            headers: {
                Allow: 'POST',
            },
        });
    }

    if (!hasSameOriginMutationSource(request)) {
        return new NextResponse('Forbidden', {
            status: 403,
        });
    }

    const url = new URL(request.url);
    url.pathname = '/';
    const response = NextResponse.redirect(url, 303);

    // Mirror the auth cookie attributes so the browser overwrites it reliably.
    response.cookies.set({
        name: getCookieName(),
        value: '',
        path: getCookiePath(),
        maxAge: 0,
        httpOnly: true,
        secure: process.env.NODE_ENV === 'production',
        sameSite: 'lax',
    });

    return response;
}
