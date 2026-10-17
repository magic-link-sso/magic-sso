// SPDX-License-Identifier: MIT
// A loopback-only stand-in for an existing private application.
import { createServer } from 'node:http';

const port = Number(process.env.PORT ?? 3007);
if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new Error('PORT must be an integer between 1 and 65535.');
}
const server = createServer((_request, response) => {
    response.writeHead(200, {
        'content-type': 'text/html; charset=utf-8',
        'cache-control': 'no-store',
    });
    response.end(
        '<!doctype html><html lang="en"><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>Magic Link SSO private app</title><h1>Your private application</h1><p>This response came from the private upstream.</p><form method="post" action="/_magicgate/logout"><button type="submit">Sign out</button></form></html>',
    );
});
server.listen(port, '127.0.0.1', () =>
    console.info(`Private upstream listening on http://127.0.0.1:${port}`),
);
for (const signal of ['SIGINT', 'SIGTERM']) {
    process.on(signal, () => {
        server.close();
    });
}
