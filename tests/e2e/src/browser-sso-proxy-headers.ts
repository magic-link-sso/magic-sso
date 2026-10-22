// SPDX-License-Identifier: MIT
import type { IncomingHttpHeaders } from 'node:http';

/** Each proxy hop must advertise its own connection lifetime. */
export function browserSsoProxyHeaders(headers: IncomingHttpHeaders): IncomingHttpHeaders {
    const forwarded = { ...headers };
    for (const name of ['connection', 'keep-alive', ...(headers.connection ?? '').split(',')]) {
        delete forwarded[name.trim().toLowerCase()];
    }
    return forwarded;
}
