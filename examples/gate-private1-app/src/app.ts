// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Wojciech Polak

import websocket from '@fastify/websocket';
import Fastify, { type FastifyInstance } from 'fastify';
import { renderHomePage } from './html.js';

export interface UpstreamConfig {
    basePath: string;
}

export interface CreateUpstreamAppOptions {
    config?: Partial<UpstreamConfig>;
    logger?: false | { level: 'trace' | 'debug' | 'info' | 'warn' | 'error' | 'fatal' };
}

export function normaliseBasePath(value: string | undefined): string {
    if (typeof value !== 'string' || value.trim().length === 0) {
        return '';
    }

    const trimmed = value.trim();
    if (!trimmed.startsWith('/')) {
        throw new Error('APP_BASE_PATH must start with "/".');
    }

    if (trimmed === '/') {
        return '';
    }

    return trimmed.endsWith('/') ? trimmed.slice(0, -1) : trimmed;
}

function getConfig(config?: Partial<UpstreamConfig>): UpstreamConfig {
    return {
        basePath: config?.basePath ?? normaliseBasePath(process.env['APP_BASE_PATH']),
    };
}

function readForwardedEmail(headers: Record<string, string | string[] | undefined>): string {
    const rawValue = headers['x-magic-sso-user-email'];
    if (Array.isArray(rawValue)) {
        return rawValue[0] ?? 'unknown@example.com';
    }

    return typeof rawValue === 'string' && rawValue.length > 0 ? rawValue : 'unknown@example.com';
}

function buildPath(basePath: string, pathname: string): string {
    if (basePath.length === 0) {
        return pathname;
    }

    return pathname === '/' ? basePath : `${basePath}${pathname}`;
}

function writeSseFrame(reply: NodeJS.WritableStream, event: string, data: unknown): void {
    reply.write(`event: ${event}\n`);
    reply.write(`data: ${JSON.stringify(data)}\n\n`);
}

export async function createApp(options: CreateUpstreamAppOptions = {}): Promise<FastifyInstance> {
    const config = getConfig(options.config);
    const app = Fastify({
        logger:
            typeof options.logger === 'undefined'
                ? {
                      level: process.env['LOG_LEVEL'] === 'debug' ? 'debug' : 'info',
                  }
                : options.logger,
    });

    await app.register(websocket);

    app.get(buildPath(config.basePath, '/healthz'), async () => ({ ok: true }));

    app.get(buildPath(config.basePath, '/'), async (request, reply) => {
        reply.type('text/html; charset=utf-8');
        return reply.send(
            renderHomePage({
                apiPath: buildPath(config.basePath, '/api/whoami'),
                assetPath: buildPath(config.basePath, '/assets/app.js'),
                basePath: config.basePath,
                email: readForwardedEmail(request.headers),
                eventPath: buildPath(config.basePath, '/events'),
                sessionPath: buildPath(config.basePath, '/_magicgate/session'),
                websocketPath: buildPath(config.basePath, '/ws'),
            }),
        );
    });

    app.get(buildPath(config.basePath, '/assets/app.js'), async (_request, reply) => {
        reply.type('application/javascript; charset=utf-8');
        return reply.send(
            [
                'const banner = document.createElement("div");',
                'banner.id = "asset-loaded";',
                'banner.hidden = true;',
                'banner.textContent = "Gate asset loaded";',
                'document.body.appendChild(banner);',
            ].join('\n'),
        );
    });

    app.get(buildPath(config.basePath, '/api/whoami'), async (request) => ({
        email: readForwardedEmail(request.headers),
        path: request.url,
        proxied: true,
        scope: request.headers['x-magic-sso-user-scope'] ?? null,
        siteId: request.headers['x-magic-sso-site-id'] ?? null,
    }));

    app.get(buildPath(config.basePath, '/events'), async (request, reply) => {
        reply.raw.setHeader('cache-control', 'no-store');
        reply.raw.setHeader('connection', 'keep-alive');
        reply.raw.setHeader('content-type', 'text/event-stream; charset=utf-8');
        reply.hijack();

        const payload = {
            email: readForwardedEmail(request.headers),
            ok: true,
        };
        writeSseFrame(reply.raw, 'ready', payload);
        const timer = setInterval(() => {
            writeSseFrame(reply.raw, 'ping', payload);
        }, 250);

        request.raw.on('close', () => {
            clearInterval(timer);
        });
    });

    app.get(buildPath(config.basePath, '/ws'), { websocket: true }, (socket, request) => {
        const email = readForwardedEmail(request.headers);
        socket.send(JSON.stringify({ email, ok: true, via: 'websocket' }));
    });

    return app;
}
