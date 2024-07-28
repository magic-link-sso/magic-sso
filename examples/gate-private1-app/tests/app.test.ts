// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Wojciech Polak

import { afterEach, describe, expect, it } from 'vitest';
import { createApp } from '../src/app.js';

const runningApps: Array<Awaited<ReturnType<typeof createApp>>> = [];

afterEach(async () => {
    while (runningApps.length > 0) {
        const app = runningApps.pop();
        if (typeof app !== 'undefined') {
            await app.close();
        }
    }
});

describe('private1 example', () => {
    it('renders the HTML page and forwarded identity', async () => {
        const app = await createApp({ logger: false });
        runningApps.push(app);

        const response = await app.inject({
            headers: {
                'x-magic-sso-user-email': 'friend@example.com',
            },
            method: 'GET',
            url: '/',
        });

        expect(response.statusCode).toBe(200);
        expect(response.body).toContain('Your private1 session is locked in and proxied.');
        expect(response.body).toContain('friend@example.com');
        expect(response.body).toContain('/_magicgate/session');
    });

    it('returns identity JSON and supports path prefixes', async () => {
        const app = await createApp({
            config: {
                basePath: '/private',
            },
            logger: false,
        });
        runningApps.push(app);

        const response = await app.inject({
            headers: {
                'x-magic-sso-site-id': 'private',
                'x-magic-sso-user-email': 'friend@example.com',
                'x-magic-sso-user-scope': 'album-A',
            },
            method: 'GET',
            url: '/private/api/whoami',
        });

        expect(response.statusCode).toBe(200);
        expect(response.json()).toEqual({
            email: 'friend@example.com',
            path: '/private/api/whoami',
            proxied: true,
            scope: 'album-A',
            siteId: 'private',
        });
    });
});
