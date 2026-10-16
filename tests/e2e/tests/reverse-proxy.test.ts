// SPDX-License-Identifier: MIT

import { createServer, type Server } from 'node:http';
import { afterEach, describe, expect, it } from 'vitest';
import { startReverseProxies } from '../src/reverse-proxy.js';

const servers: Server[] = [];
async function listen(server: Server): Promise<number> {
    servers.push(server);
    await new Promise<void>((resolve, reject) => {
        server.once('error', reject);
        server.listen(0, '127.0.0.1', resolve);
    });
    const address = server.address();
    if (address === null || typeof address === 'string') {
        throw new Error('Expected TCP server');
    }
    return address.port;
}
function portOf(server: Server | undefined): number {
    const address = server?.address();
    if (!address || typeof address === 'string') {
        throw new Error('Expected proxy TCP address');
    }
    return address.port;
}
afterEach(async () => {
    await Promise.all(
        servers.splice(0).map(
            (server) =>
                new Promise<void>((resolve) => {
                    server.closeAllConnections();
                    server.close(() => resolve());
                }),
        ),
    );
});

describe('reverse-proxy contract fixture', () => {
    it.each([false, true])(
        'forwards encoded paths, request bodies and cookies with replaceHost=%s',
        async (replaceHost) => {
            const upstreamPort = await listen(
                createServer(async (request, response) => {
                    const chunks: Buffer[] = [];
                    for await (const chunk of request) {
                        chunks.push(Buffer.from(chunk));
                    }
                    response.writeHead(201, {
                        'content-type': 'application/json',
                        'set-cookie': 'session=upstream; HttpOnly; SameSite=Lax',
                    });
                    response.end(
                        JSON.stringify({
                            method: request.method,
                            path: request.url,
                            body: Buffer.concat(chunks).toString(),
                            headers: request.headers,
                        }),
                    );
                }),
            );
            const proxies = await startReverseProxies([
                { publicPort: 0, upstreamPort, replaceHost },
            ]);
            servers.push(...proxies);
            const port = portOf(proxies[0]);
            const response = await fetch(
                `http://127.0.0.1:${port}/callback?value=a%2Bb&tag=one&tag=two`,
                {
                    method: 'POST',
                    body: 'email=user%40example.test',
                    headers: {
                        cookie: 'request-cookie=1',
                        forwarded: 'host=attacker.test;proto=https',
                        'x-forwarded-host': 'attacker.test',
                        'x-forwarded-proto': 'https',
                    },
                },
            );
            expect(response.status).toBe(201);
            expect(response.headers.get('set-cookie')).toContain('session=upstream');
            expect(await response.json()).toMatchObject({
                method: 'POST',
                path: '/callback?value=a%2Bb&tag=one&tag=two',
                body: 'email=user%40example.test',
                headers: {
                    host: `127.0.0.1:${replaceHost ? upstreamPort : port}`,
                    'x-forwarded-host': `127.0.0.1:${port}`,
                    'x-forwarded-proto': 'http',
                    cookie: 'request-cookie=1',
                },
            });
        },
    );
    it('returns 502 for an unavailable upstream and closes earlier listeners after startup failure', async () => {
        const unavailable = createServer();
        const port = await listen(unavailable);
        await new Promise<void>((resolve) => unavailable.close(() => resolve()));
        const proxies = await startReverseProxies([
            { publicPort: 0, upstreamPort: port, replaceHost: false },
        ]);
        servers.push(...proxies);
        expect((await fetch(`http://127.0.0.1:${portOf(proxies[0])}/`)).status).toBe(502);
        const occupied = await listen(createServer());
        await expect(
            startReverseProxies([
                { publicPort: 0, upstreamPort: port, replaceHost: false },
                { publicPort: occupied, upstreamPort: port, replaceHost: false },
            ]),
        ).rejects.toThrow();
    });
});
