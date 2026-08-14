// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Wojciech Polak

import {
    buildLoginTarget,
    readCookieValue,
    toSecretKey,
    verifyAuthToken,
} from '../../dist/index.js';

export default {
    async fetch(request, env) {
        const token = readCookieValue(request.headers.get('cookie'), 'magic-sso');
        const auth = token
            ? await verifyAuthToken(token, toSecretKey(env.JWT_SECRET), {
                  expectedAudience: 'https://app.example.test',
                  expectedIssuer: 'https://sso.example.test',
              })
            : null;

        if (auth === null) {
            return new Response('Unauthorized', { status: 401 });
        }

        return Response.json({
            email: auth.email,
            loginTarget: buildLoginTarget({
                appOrigin: 'https://app.example.test',
                returnUrl: new URL(request.url).pathname,
            }),
        });
    },
};
