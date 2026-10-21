// SPDX-License-Identifier: MIT
// Ephemeral TLS termination and browser CONNECT proxy for reserved .test domains.
import { createServer as createHttpServer, request as forwardHttp } from 'node:http';
import { createServer as createHttpsServer } from 'node:https';
import { connect } from 'node:net';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import {
    browserSsoTestHosts,
    browserSsoTestPorts,
    browserSsoProxyUrl,
} from './browser-sso-fixture.js';
const directory = process.env.MAGICSSO_E2E_TLS_DIR;
if (!directory) {
    throw new Error('Missing ephemeral test TLS directory');
}
const tls = {
    key: await readFile(join(directory, 'key.pem')),
    cert: await readFile(join(directory, 'cert.pem')),
};
const servers = browserSsoTestPorts.map((port) => {
    const server = createHttpsServer(tls, (request, response) => {
        const forwarded = forwardHttp(
            {
                hostname: '127.0.0.1',
                port: port + 1000,
                path: request.url,
                method: request.method,
                headers: { ...request.headers, 'x-forwarded-proto': 'https' },
            },
            (upstream) => {
                response.writeHead(upstream.statusCode ?? 502, upstream.headers);
                upstream.on('aborted', () => response.destroy());
                upstream.pipe(response);
            },
        );
        forwarded.on('error', () => {
            response.writeHead(502);
            response.end();
        });
        request.pipe(forwarded);
    });
    server.listen(port, '127.0.0.1');
    return server;
});
const proxy = createHttpServer((request, response) => {
    if (request.url === '/ready') {
        response.writeHead(200);
        response.end('ready');
        return;
    }
    const url = new URL(request.url ?? '/', `http://${request.headers.host ?? 'localhost'}`);
    if (!['localhost', '127.0.0.1'].includes(url.hostname) || url.port !== '43126') {
        response.writeHead(403);
        response.end();
        return;
    }
    const upstream = forwardHttp(
        {
            hostname: '127.0.0.1',
            port: 43126,
            path: url.pathname + url.search,
            method: request.method,
            headers: request.headers,
        },
        (result) => {
            response.writeHead(result.statusCode ?? 502, result.headers);
            result.pipe(response);
        },
    );
    upstream.on('error', () => {
        response.writeHead(502);
        response.end();
    });
    request.pipe(upstream);
});
proxy.on('connect', (request, socket, head) => {
    const url = new URL(`https://${request.url ?? ''}`);
    if (
        !(
            browserSsoTestHosts.includes(url.hostname) &&
            browserSsoTestPorts.includes(Number(url.port))
        ) &&
        !(['localhost', '127.0.0.1'].includes(url.hostname) && url.port === '43126')
    ) {
        socket.end('HTTP/1.1 403 Forbidden\r\n\r\n');
        return;
    }
    const upstream = connect(Number(url.port), '127.0.0.1', () => {
        socket.write('HTTP/1.1 200 Connection Established\r\n\r\n');
        if (head.length) {
            upstream.write(head);
        }
        upstream.pipe(socket);
        socket.pipe(upstream);
    });
    upstream.on('error', () => socket.destroy());
    socket.on('error', () => upstream.destroy());
    socket.on('close', () => upstream.destroy());
});
proxy.listen(Number(new URL(browserSsoProxyUrl).port), '127.0.0.1');
function close(): void {
    for (const server of [...servers, proxy]) {
        server.closeAllConnections();
        server.close();
    }
}
process.once('SIGTERM', close);
process.once('SIGINT', close);
