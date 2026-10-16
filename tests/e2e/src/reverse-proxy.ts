// SPDX-License-Identifier: MIT

import { createServer, request as upstreamRequest, type Server } from 'node:http';
import { fileURLToPath } from 'node:url';

export interface ProxyRoute {
    publicPort: number;
    upstreamPort: number;
    replaceHost: boolean;
}

/** Test-only HTTP proxy: preserve bodies/cookies and replace untrusted forwarding headers. */
export async function startReverseProxies(routes: readonly ProxyRoute[]): Promise<Server[]> {
    const servers: Server[] = [];
    try {
        for (const route of routes) {
            const server = createServer((request, response) => {
                const headers = { ...request.headers };
                delete headers.forwarded;
                headers['x-forwarded-host'] = request.headers.host;
                headers['x-forwarded-proto'] = 'http';
                headers['x-forwarded-for'] = request.socket.remoteAddress;
                if (route.replaceHost) {
                    headers.host = `127.0.0.1:${route.upstreamPort}`;
                }
                const upstream = upstreamRequest(
                    {
                        hostname: '127.0.0.1',
                        port: route.upstreamPort,
                        method: request.method,
                        path: request.url,
                        headers,
                    },
                    (result) => {
                        response.writeHead(result.statusCode ?? 502, result.headers);
                        result.pipe(response);
                    },
                );
                upstream.on('error', () => {
                    if (!response.headersSent) {
                        response.writeHead(502);
                    }
                    response.end();
                });
                request.on('aborted', () => upstream.destroy());
                response.on('close', () => upstream.destroy());
                request.pipe(upstream);
            });
            servers.push(server);
            await new Promise<void>((resolve, reject) => {
                server.once('error', reject);
                server.listen(route.publicPort, '127.0.0.1', resolve);
            });
        }
        return servers;
    } catch (error) {
        for (const server of servers) {
            server.closeAllConnections();
            server.close();
        }
        throw error;
    }
}

function parseRoutes(source: string): ProxyRoute[] {
    const value: unknown = JSON.parse(source);
    if (!Array.isArray(value)) {
        throw new Error('Expected an array of proxy routes');
    }
    return value.map((route: unknown) => {
        if (
            typeof route !== 'object' ||
            route === null ||
            !('publicPort' in route) ||
            !('upstreamPort' in route) ||
            !('replaceHost' in route)
        ) {
            throw new Error('Invalid proxy route');
        }
        const { publicPort, upstreamPort, replaceHost } = route;
        if (
            typeof publicPort !== 'number' ||
            typeof upstreamPort !== 'number' ||
            typeof replaceHost !== 'boolean'
        ) {
            throw new Error('Invalid proxy route fields');
        }
        return { publicPort, upstreamPort, replaceHost };
    });
}

if (process.argv[1] !== undefined && fileURLToPath(import.meta.url) === process.argv[1]) {
    const servers = await startReverseProxies(
        parseRoutes(process.env.MAGICSSO_E2E_PROXY_ROUTES ?? '[]'),
    );
    const shutdown = (): void => {
        for (const server of servers) {
            server.closeAllConnections();
            server.close();
        }
    };
    process.once('SIGTERM', shutdown);
    process.once('SIGINT', shutdown);
}
