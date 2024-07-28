// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Wojciech Polak

import 'dotenv/config';
import { createApp } from './app.js';

const port = Number.parseInt(process.env['PORT'] ?? '3007', 10);
const app = await createApp();

await app.listen({
    host: '0.0.0.0',
    port,
});

console.log(`private1 example listening on http://localhost:${port}`);
