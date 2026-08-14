// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Wojciech Polak

export const authFixture = {
    audience: 'https://app.example.test',
    email: 'person@example.test',
    issuer: 'https://sso.example.test',
    jti: 'token-id',
    scope: '*',
    secret: 'test-secret',
    siteId: 'site-a',
} as const;

export const unsafeReturnUrlFixtures = [
    '//evil.example',
    '\\evil.example',
    'https://evil.example/',
    'mailto:person@example.test',
    'https://user:pass@app.example.test/',
    'https:%2f%2fevil.example/',
] as const;
