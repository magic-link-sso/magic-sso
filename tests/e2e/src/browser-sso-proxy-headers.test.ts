// SPDX-License-Identifier: MIT
import { createServer, request, type Server, type IncomingHttpHeaders } from 'node:http';
import { afterEach, expect, it } from 'vitest';
import { browserSsoProxyHeaders } from './browser-sso-proxy-headers.js';

const servers: Server[] = [];
async function listen(server: Server): Promise<number> {
    servers.push(server);
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const address = server.address();
    if (!address || typeof address === 'string') {
        throw new Error('Expected TCP listener');
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

it('advertises the proxy timeout instead of the upstream timeout and preserves application headers', async () => {
    let received: IncomingHttpHeaders | undefined;
    const upstream = createServer((request, response) => {
        received = request.headers;
        response.writeHead(201, {
            connection: 'keep-alive, x-upstream-only',
            'keep-alive': 'timeout=72',
            'x-upstream-only': 'private to this hop',
            'content-type': 'application/json',
            'set-cookie': ['session=one; HttpOnly', 'transaction=; Max-Age=0'],
        });
        request.pipe(response);
    });
    upstream.keepAliveTimeout = 72_000;
    const upstreamPort = await listen(upstream);
    const proxy = createServer((incoming, outgoing) => {
        const forwarded = request(
            {
                hostname: '127.0.0.1',
                port: upstreamPort,
                method: incoming.method,
                headers: browserSsoProxyHeaders(incoming.headers),
            },
            (response) => {
                outgoing.writeHead(
                    response.statusCode ?? 502,
                    browserSsoProxyHeaders(response.headers),
                );
                response.pipe(outgoing);
            },
        );
        incoming.pipe(forwarded);
    });
    proxy.keepAliveTimeout = 5_000;
    const port = await listen(proxy);
    const response = await new Promise<{
        status: number;
        headers: IncomingHttpHeaders;
        body: string;
    }>((resolve, reject) => {
        const client = request(
            {
                hostname: '127.0.0.1',
                port,
                method: 'POST',
                headers: {
                    connection: 'keep-alive, x-client-only',
                    'keep-alive': 'timeout=120',
                    'x-client-only': 'private to this hop',
                    cookie: 'transaction=proof',
                    'content-type': 'application/json',
                },
            },
            async (result) => {
                let body = '';
                for await (const chunk of result) {
                    body += chunk;
                }
                resolve({ status: result.statusCode ?? 0, headers: result.headers, body });
            },
        );
        client.on('error', reject);
        client.end('{"code":"test-code"}');
    });

    expect(response.status).toBe(201);
    expect(response.headers['keep-alive']).toBe('timeout=5');
    expect(response.headers['x-upstream-only']).toBeUndefined();
    expect(received?.['keep-alive']).toBeUndefined();
    expect(received?.['x-client-only']).toBeUndefined();
    expect(received?.cookie).toBe('transaction=proof');
    expect(response.headers['content-type']).toBe('application/json');
    expect(response.headers['set-cookie']).toEqual([
        'session=one; HttpOnly',
        'transaction=; Max-Age=0',
    ]);
    expect(response.body).toBe('{"code":"test-code"}');
});
