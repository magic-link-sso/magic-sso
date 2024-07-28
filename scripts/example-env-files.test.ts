// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Wojciech Polak

import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

type ExampleEnvSpec = Readonly<{
    filePath: string;
    requiredEntries: Readonly<Record<string, string>>;
}>;

function parseEnvFile(contents: string): Map<string, string> {
    const entries = new Map<string, string>();

    for (const rawLine of contents.split(/\r?\n/u)) {
        const line = rawLine.trim();

        if (line.length === 0 || line.startsWith('#')) {
            continue;
        }

        const separatorIndex = line.indexOf('=');
        if (separatorIndex === -1) {
            continue;
        }

        const key = line.slice(0, separatorIndex).trim();
        const value = line.slice(separatorIndex + 1).trim();
        entries.set(key, value);
    }

    return entries;
}

async function readExampleEnvFile(filePath: string): Promise<Map<string, string>> {
    const absolutePath = path.join(process.cwd(), filePath);
    const contents = await readFile(absolutePath, 'utf8');

    return parseEnvFile(contents);
}

const exampleEnvSpecs: readonly ExampleEnvSpec[] = [
    {
        filePath: 'examples/angular/.env.example',
        requiredEntries: {
            MAGICSSO_COOKIE_MAX_AGE: '3600',
            MAGICSSO_COOKIE_NAME: 'magic-sso',
            MAGICSSO_COOKIE_PATH: '/',
            MAGICSSO_DIRECT_USE: 'false',
            MAGICSSO_JWT_SECRET: 'VERY-VERY-LONG-RANDOM-JWT-SECRET',
            MAGICSSO_PREVIEW_SECRET: 'VERY-VERY-LONG-RANDOM-PREVIEW-SECRET',
            MAGICSSO_SERVER_URL: 'http://localhost:3000',
        },
    },
    {
        filePath: 'examples/fastify/.env.example',
        requiredEntries: {
            MAGICSSO_COOKIE_MAX_AGE: '3600',
            MAGICSSO_COOKIE_NAME: 'magic-sso',
            MAGICSSO_COOKIE_PATH: '/',
            MAGICSSO_DIRECT_USE: 'false',
            MAGICSSO_JWT_SECRET: 'VERY-VERY-LONG-RANDOM-JWT-SECRET',
            MAGICSSO_PREVIEW_SECRET: 'VERY-VERY-LONG-RANDOM-PREVIEW-SECRET',
            MAGICSSO_SERVER_URL: 'http://localhost:3000',
            PORT: '3005',
        },
    },
    {
        filePath: 'examples/nextjs/.env.local.example',
        requiredEntries: {
            MAGICSSO_COOKIE_MAX_AGE: '3600',
            MAGICSSO_COOKIE_NAME: 'magic-sso',
            MAGICSSO_COOKIE_PATH: '/',
            MAGICSSO_DIRECT_USE: 'false',
            MAGICSSO_JWT_SECRET: 'VERY-VERY-LONG-RANDOM-JWT-SECRET',
            MAGICSSO_PREVIEW_SECRET: 'VERY-VERY-LONG-RANDOM-PREVIEW-SECRET',
            MAGICSSO_PUBLIC_ORIGIN: 'http://localhost:3001',
            MAGICSSO_SERVER_URL: 'http://localhost:3000',
        },
    },
    {
        filePath: 'examples/nuxt/.env.example',
        requiredEntries: {
            MAGICSSO_COOKIE_MAX_AGE: '3600',
            MAGICSSO_COOKIE_NAME: 'magic-sso',
            MAGICSSO_COOKIE_PATH: '/',
            MAGICSSO_DIRECT_USE: 'false',
            MAGICSSO_JWT_SECRET: 'VERY-VERY-LONG-RANDOM-JWT-SECRET',
            MAGICSSO_PREVIEW_SECRET: 'VERY-VERY-LONG-RANDOM-PREVIEW-SECRET',
            MAGICSSO_PUBLIC_ORIGIN: 'http://localhost:3002',
            MAGICSSO_SERVER_URL: 'http://localhost:3000',
        },
    },
    {
        filePath: 'examples/django/.env.example',
        requiredEntries: {
            DJANGO_ALLOWED_HOSTS: 'localhost,127.0.0.1',
            DJANGO_DEBUG: 'true',
            MAGICSSO_AUTH_EVERYWHERE: 'false',
            MAGICSSO_COOKIE_MAX_AGE: '3600',
            MAGICSSO_COOKIE_NAME: 'magic-sso',
            MAGICSSO_COOKIE_PATH: '/',
            MAGICSSO_COOKIE_SAMESITE: 'Lax',
            MAGICSSO_COOKIE_SECURE: 'false',
            MAGICSSO_DIRECT_USE: 'true',
            MAGICSSO_JWT_SECRET: 'VERY-VERY-LONG-RANDOM-JWT-SECRET',
            MAGICSSO_PREVIEW_SECRET: 'VERY-VERY-LONG-RANDOM-PREVIEW-SECRET',
            MAGICSSO_PUBLIC_URLS: 'login',
            MAGICSSO_REQUEST_TIMEOUT: '5',
            MAGICSSO_SERVER_URL: 'http://localhost:3000',
        },
    },
];

describe('example env templates', () => {
    for (const spec of exampleEnvSpecs) {
        it(`keeps ${spec.filePath} aligned with the required defaults`, async () => {
            const envEntries = await readExampleEnvFile(spec.filePath);

            for (const [key, value] of Object.entries(spec.requiredEntries)) {
                expect(
                    envEntries.get(key),
                    `${spec.filePath} is missing ${key} or has the wrong default value`,
                ).toBe(value);
            }
        });
    }
});
