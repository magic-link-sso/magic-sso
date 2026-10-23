// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 Wojciech Polak

import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { buildApp, MANAGER_SESSION_COOKIE_NAME } from './app.js';
import { applyManagerState } from './apply.js';
import { loadManagerAuditEvents } from './audit.js';
import {
    changePersonAccess,
    confirmPersonAccess,
    getPersonAccess,
    listPeople,
    previewPersonAccess,
} from './people.js';
import { buildRuntimePlan } from './runtime.js';
import { buildManagerDiff, loadManagerStateOrEmpty } from './service.js';
import { saveManagerState, stringifyManagerState, type ManagerState } from './state.js';
import type { ManagerRuntimeSettings } from './settings.js';

const directories: string[] = [];
const token = 'test-manager-api-token-0123456789abcdefghijk';
const email = 'person@example.com';
const headers = {
    cookie: `${MANAGER_SESSION_COOKIE_NAME}=${token}`,
    host: 'manager.example.test',
    origin: 'http://manager.example.test',
    'content-type': 'application/x-www-form-urlencoded',
};
const now = new Date('2026-10-23T12:00:00Z');

function fixture(): { settings: ManagerRuntimeSettings; state: ManagerState } {
    const directory = mkdtempSync(join(tmpdir(), 'magic-sso-people-'));
    directories.push(directory);
    const settings: ManagerRuntimeSettings = {
        configFilePath: join(directory, 'manager.toml'),
        managedSiteIds: ['alpha', 'beta'],
        bootstrapAdminSiteId: 'admin',
        audit: {
            integrityKey: 'test-audit-integrity-key-0123456789abcdefghijk',
            maxArchivedFiles: 4,
            maxFileBytes: 1024 * 1024,
        },
        service: { host: '127.0.0.1', port: 4311, auth: { bearerToken: token } },
        paths: {
            auditFile: join(directory, 'audit.ndjson'),
            baseConfigFile: join(directory, 'base.toml'),
            lastGoodRuntimeConfigFile: join(directory, 'last-good.toml'),
            lockFile: join(directory, 'manager.lock'),
            runtimeConfigFile: join(directory, 'runtime.toml'),
            stateFile: join(directory, 'state.json'),
        },
    };
    writeFileSync(
        settings.paths.baseConfigFile,
        `
[auth]
jwtSecret = "test-jwt-secret-0123456789abcdefghijk"
csrfSecret = "test-csrf-secret-0123456789abcdefghijk"
emailSecret = "test-email-secret-0123456789abcdefghijk"
previewSecret = "test-preview-secret-0123456789abcdefghijk"
jwtExpiration = "2h"
[email]
from = "owner@example.com"
[email.smtp]
host = "localhost"
user = "test"
pass = "test"
${['alpha', 'beta', 'admin']
    .map(
        (id) => `
[[sites]]
id = "${id}"
origins = ["https://${id}.example.test"]
allowedRedirectUris = ["https://${id}.example.test/verify-email"]
allowedEmails = ["${id === 'admin' ? email : 'base-only@example.com'}"]
[[sites.accessRules]]
email = "${email}"
scopes = ["read", "write"]
`,
    )
    .join('')}`,
    );
    const state: ManagerState = {
        version: 1,
        metadata: {},
        managedSites: {
            alpha: { grants: [{ email, scopes: ['read'] }], scopeCatalog: ['read', 'write'] },
            beta: {
                grants: [{ email: 'other@example.com', scopes: ['*'] }],
                scopeCatalog: ['read'],
            },
        },
    };
    saveManagerState(settings.paths.stateFile, state);
    return { settings, state };
}

function reloadSettings(settings: ManagerRuntimeSettings): ManagerRuntimeSettings {
    return {
        ...settings,
        reload: {
            url: 'http://localhost/internal/access-config/reload',
            secret: 'test-reload-secret-0123456789abcdefghijk',
            timeoutMs: 1000,
        },
    };
}

async function successfulReload(
    _input: string | URL | Request,
    _init?: RequestInit,
): Promise<Response> {
    return Response.json({ reloaded: true, changedSiteIds: ['alpha', 'beta'] });
}

function previewToken(html: string): string {
    const match = /name="previewToken" value="([^"]+)"/u.exec(html);
    if (!match?.[1]) {
        throw new Error(`Missing preview token: ${html.slice(-1500)}`);
    }
    return match[1];
}

afterEach(() => {
    directories
        .splice(0)
        .forEach((directory) => rmSync(directory, { recursive: true, force: true }));
});

describe('person effective access', () => {
    it('uses managed grants as replacements and identifies every operator-owned source', () => {
        const { settings, state } = fixture();
        const view = getPersonAccess(state, settings, ' PERSON@EXAMPLE.COM ');
        expect(view.email).toBe(email);
        expect(view.jwtLifetimeSeconds).toBe(7200);
        expect(view.applications.find((app) => app.siteId === 'alpha')).toMatchObject({
            managed: true,
            savedScopes: ['read'],
            sources: [`Manager state grant: alpha / ${email}`],
        });
        expect(view.applications.find((app) => app.siteId === 'beta')?.savedScopes).toEqual([]);
        expect(view.applications.find((app) => app.siteId === 'admin')).toMatchObject({
            managed: false,
            savedScopes: ['*'],
            sources: [
                'Operator base config: admin.allowedEmails',
                'Operator base config: admin.accessRules[0] (read, write)',
            ],
        });
        expect(listPeople(state, settings)).toEqual(['other@example.com', email]);
        expect(view.activeConfirmed).toBe(false);
        expect(view.activation).toContain('unconfirmed');
    });

    it('retains people from published rules after their saved access has been removed', () => {
        const { settings, state } = fixture();
        writeFileSync(
            settings.paths.runtimeConfigFile,
            buildRuntimePlan(state, settings).runtimeToml,
        );
        const next = changePersonAccess(state, settings, email, [{ siteId: 'alpha', scopes: [] }]);
        const app = getPersonAccess(next, settings, email).applications.find(
            (entry) => entry.siteId === 'alpha',
        );
        expect(app).toMatchObject({
            savedScopes: [],
            publishedScopes: ['read'],
            publishedSources: ['Published runtime config: alpha.accessRules[0] (read)'],
        });
        expect(listPeople(next, settings)).toContain(email);
    });

    it('acknowledges active configuration only after a matching successful reload', async () => {
        const { settings, state } = fixture();
        const applied = await applyManagerState(state, reloadSettings(settings), {
            now,
            fetchImplementation: successfulReload,
        });
        expect(getPersonAccess(applied.updatedState, settings, email).activeConfirmed).toBe(true);
        const pending = changePersonAccess(applied.updatedState, settings, email, [
            { siteId: 'alpha', scopes: ['*'] },
        ]);
        expect(getPersonAccess(pending, settings, email)).toMatchObject({ activeConfirmed: true });
        expect(
            getPersonAccess(pending, settings, email).applications.find(
                (entry) => entry.siteId === 'alpha',
            ),
        ).toMatchObject({ savedScopes: ['*'], publishedScopes: ['read'] });
        const written = await applyManagerState(pending, settings, { now });
        expect(getPersonAccess(written.updatedState, settings, email).activeConfirmed).toBe(false);
    });

    it('does not call a manually modified runtime active', async () => {
        const { settings, state } = fixture();
        await applyManagerState(state, reloadSettings(settings), {
            now,
            fetchImplementation: successfulReload,
        });
        writeFileSync(
            settings.paths.runtimeConfigFile,
            `${readFileSync(settings.paths.runtimeConfigFile, 'utf8')}\n# operator edit\n`,
        );
        expect(getPersonAccess(state, settings, email).activeConfirmed).toBe(false);
    });

    it('marks activation unconfirmed after a reload loses its response, even if the file rolls back', async () => {
        const { settings, state } = fixture();
        const target = reloadSettings(settings);
        const applied = await applyManagerState(state, target, {
            now,
            fetchImplementation: successfulReload,
        });
        const previousRuntime = readFileSync(settings.paths.runtimeConfigFile, 'utf8');
        const next = changePersonAccess(applied.updatedState, settings, email, [
            { siteId: 'alpha', scopes: [] },
        ]);
        await expect(
            applyManagerState(next, target, {
                now: new Date(now.getTime() + 1000),
                fetchImplementation: async (): Promise<Response> => {
                    throw new Error('response lost after reload');
                },
            }),
        ).rejects.toThrow('response lost after reload');
        expect(readFileSync(settings.paths.runtimeConfigFile, 'utf8')).toBe(previousRuntime);
        expect(getPersonAccess(next, settings, email).activeConfirmed).toBe(false);
    });

    it('keeps published access visible when an operator removes an unmanaged application from the base', () => {
        const { settings, state } = fixture();
        const base = readFileSync(settings.paths.baseConfigFile, 'utf8');
        writeFileSync(
            settings.paths.baseConfigFile,
            `${base}\n[[sites]]\nid = "retired"\norigins = ["https://retired.example.test"]\nallowedRedirectUris = ["https://retired.example.test/callback"]\nallowedEmails = ["retired-user@example.com"]\n`,
        );
        writeFileSync(
            settings.paths.runtimeConfigFile,
            buildRuntimePlan(state, settings).runtimeToml,
        );
        writeFileSync(settings.paths.baseConfigFile, base);
        expect(listPeople(state, settings)).toContain('retired-user@example.com');
        expect(
            getPersonAccess(state, settings, 'retired-user@example.com').applications.find(
                (entry) => entry.siteId === 'retired',
            ),
        ).toMatchObject({
            managed: false,
            savedScopes: [],
            publishedScopes: ['*'],
            sources: [],
            publishedSources: ['Published runtime config: retired.allowedEmails'],
        });
    });
});

describe('person access preview and atomic changes', () => {
    it('previews without persistence and grants/revokes several applications together', () => {
        const { settings, state } = fixture();
        const original = readFileSync(settings.paths.stateFile, 'utf8');
        const preview = previewPersonAccess(
            state,
            settings,
            email,
            [
                { siteId: 'alpha', scopes: [] },
                { siteId: 'beta', scopes: ['read'] },
            ],
            now,
        );
        expect(readFileSync(settings.paths.stateFile, 'utf8')).toBe(original);
        expect(existsSync(settings.paths.runtimeConfigFile)).toBe(false);
        expect(preview.nextState.managedSites.alpha?.grants).toEqual([]);
        expect(preview.nextState.managedSites.beta?.grants).toContainEqual({
            email,
            scopes: ['read'],
        });
        expect(confirmPersonAccess(state, settings, preview.token, now).nextState).toEqual(
            preview.nextState,
        );
        expect(
            buildRuntimePlan(preview.nextState, settings).validatedRuntimeConfig.sites.find(
                (site) => site.id === 'alpha',
            )?.accessRules.size,
        ).toBe(0);
    });

    it.each([
        [{ siteId: 'beta', scopes: ['missing'] }],
        [{ siteId: 'admin', scopes: ['*'] }],
        [{ siteId: 'unknown', scopes: ['*'] }],
        [{ siteId: 'alpha', scopes: ['*'] }],
        [{ siteId: 'beta', scopes: ['*', 'read'] }],
    ])('rejects the whole batch when a later change is invalid: %j', (invalidChange) => {
        const { settings, state } = fixture();
        const before = stringifyManagerState(state);
        expect(() =>
            changePersonAccess(state, settings, email, [
                { siteId: 'alpha', scopes: [] },
                ...invalidChange,
            ]),
        ).toThrow();
        expect(stringifyManagerState(state)).toBe(before);
        expect(readFileSync(settings.paths.stateFile, 'utf8')).toBe(before);
    });

    it.each(['state', 'base', 'runtime', 'catalog'])(
        'rejects a stale preview after %s changes',
        (changed) => {
            const { settings, state } = fixture();
            const preview = previewPersonAccess(
                state,
                settings,
                email,
                [{ siteId: 'beta', scopes: ['*'] }],
                now,
            );
            if (changed === 'state') {
                state.managedSites.alpha?.grants.push({ email: 'new@example.com', scopes: ['*'] });
            }
            if (changed === 'catalog') {
                state.managedSites.alpha?.scopeCatalog.push('new');
            }
            if (changed === 'base') {
                writeFileSync(
                    settings.paths.baseConfigFile,
                    `${readFileSync(settings.paths.baseConfigFile, 'utf8')}\n# changed\n`,
                );
            }
            if (changed === 'runtime') {
                writeFileSync(
                    settings.paths.runtimeConfigFile,
                    buildRuntimePlan(state, settings).runtimeToml,
                );
            }
            expect(() => confirmPersonAccess(state, settings, preview.token, now)).toThrow(
                'Preview expired or changed',
            );
        },
    );

    it('rejects expired, tampered and unsigned previews', () => {
        const { settings, state } = fixture();
        const preview = previewPersonAccess(
            state,
            settings,
            email,
            [{ siteId: 'beta', scopes: ['*'] }],
            now,
        );
        expect(() =>
            confirmPersonAccess(state, settings, preview.token, new Date(now.getTime() + 600_000)),
        ).toThrow('Preview expired or changed');
        for (const value of ['', `${preview.token}x`, `${preview.token}.extra`, 'unsigned']) {
            expect(() => confirmPersonAccess(state, settings, value, now)).toThrow(
                'Preview expired or changed',
            );
        }
    });
});

describe('people manager pages', () => {
    it('reports invalid emails and incomplete scoped forms without changing state', async () => {
        const { settings, state } = fixture();
        const app = await buildApp({ settings, logger: false });
        try {
            expect((await app.inject({ url: '/people?email=invalid', headers })).statusCode).toBe(
                400,
            );
            const methods: Array<'GET' | 'POST'> = ['GET', 'POST'];
            for (const method of methods) {
                const url = method === 'GET' ? '/people/invalid' : '/people/invalid/preview';
                expect(
                    (
                        await app.inject({
                            url,
                            method,
                            headers,
                            ...(method === 'POST' ? { payload: 'site0=alpha&mode0=full' } : {}),
                        })
                    ).statusCode,
                ).toBe(400);
            }
            const response = await app.inject({
                url: `/people/${email}/preview`,
                method: 'POST',
                headers,
                payload: 'site0=alpha&mode0=full&site1=beta&mode1=scoped',
            });
            expect(response.statusCode).toBe(400);
            expect(response.body).toContain('Select at least one permission for beta.');
            expect(response.body).toContain('value="full" selected');
            expect(response.body).toContain('value="scoped" selected');
            expect(loadManagerStateOrEmpty(settings)).toEqual(state);
        } finally {
            await app.close();
        }
    });

    it.each(['saved access', 'runtime file', 'missing revision'])(
        'requires a new publication preview after %s changes',
        async (changed) => {
            const { settings, state } = fixture();
            const app = await buildApp({ settings, logger: false });
            try {
                const revision = buildManagerDiff(state, settings).publicationRevision;
                const diff = await app.inject({ url: '/diff', headers });
                expect(diff.body).toContain(`name="publicationRevision" value="${revision}"`);
                if (changed === 'saved access') {
                    saveManagerState(
                        settings.paths.stateFile,
                        changePersonAccess(state, settings, email, [
                            { siteId: 'beta', scopes: ['*'] },
                        ]),
                    );
                }
                if (changed === 'runtime file') {
                    writeFileSync(
                        settings.paths.runtimeConfigFile,
                        buildRuntimePlan(state, settings).runtimeToml,
                    );
                }
                const before = existsSync(settings.paths.runtimeConfigFile)
                    ? readFileSync(settings.paths.runtimeConfigFile, 'utf8')
                    : undefined;
                const response = await app.inject({
                    url: '/diff/apply',
                    method: 'POST',
                    headers,
                    payload: new URLSearchParams({
                        publicationRevision: changed === 'missing revision' ? '' : revision,
                    }).toString(),
                });
                expect(response.statusCode).toBe(409);
                expect(response.body).toContain('Review all pending changes again');
                expect(
                    existsSync(settings.paths.runtimeConfigFile)
                        ? readFileSync(settings.paths.runtimeConfigFile, 'utf8')
                        : undefined,
                ).toBe(before);
                expect(loadManagerAuditEvents(settings)).toEqual([]);
            } finally {
                await app.close();
            }
        },
    );

    it('lists people, opens normalized email and shows read-only rule sources and lifecycle', async () => {
        const { settings } = fixture();
        const app = await buildApp({ settings, logger: false });
        try {
            expect((await app.inject({ url: '/people', headers })).body).toContain(
                `/people/${encodeURIComponent(email)}`,
            );
            expect(
                (await app.inject({ url: '/people?email=NEW%40EXAMPLE.COM', headers })).headers
                    .location,
            ).toBe('/people/new%40example.com');
            const page = await app.inject({ url: `/people/${email}`, headers });
            expect(page.statusCode).toBe(200);
            for (const text of [
                'Saved rule source',
                'Published rule source',
                'Pending',
                'Last confirmed active',
                'Operator-owned access',
                '7200 seconds',
                'removing access does not remotely sign out',
            ]) {
                expect(page.body).toContain(text);
            }
            expect(page.body).not.toContain('value="admin"');
        } finally {
            await app.close();
        }
    });

    it('saves only a confirmed multi-app preview, audits once, then publishes with reload', async () => {
        const { settings, state } = fixture();
        const app = await buildApp({
            settings: reloadSettings(settings),
            logger: false,
            now,
            fetchImplementation: successfulReload,
        });
        try {
            const preview = await app.inject({
                url: `/people/${email}/preview`,
                method: 'POST',
                headers,
                payload: 'site0=alpha&mode0=remove&site1=beta&mode1=scoped&scope1_0=read',
            });
            expect(preview.statusCode).toBe(200);
            expect(preview.body).toContain('After saving: No access');
            expect(loadManagerStateOrEmpty(settings)).toEqual(state);
            expect(existsSync(settings.paths.auditFile)).toBe(false);
            const saved = await app.inject({
                url: `/people/${email}/save`,
                method: 'POST',
                headers,
                payload: new URLSearchParams({
                    previewToken: previewToken(preview.body),
                }).toString(),
            });
            expect(saved.statusCode).toBe(303);
            expect(loadManagerStateOrEmpty(settings).managedSites.alpha?.grants).toEqual([]);
            expect(loadManagerStateOrEmpty(settings).managedSites.beta?.grants).toContainEqual({
                email,
                scopes: ['read'],
            });
            expect(existsSync(settings.paths.runtimeConfigFile)).toBe(false);
            const events = loadManagerAuditEvents(settings);
            expect(events).toHaveLength(1);
            expect(events[0]).toMatchObject({
                kind: 'access-replaced',
                changedSiteIds: ['alpha', 'beta'],
                actor: { user: 'browser-session' },
            });
            const diff = await app.inject({ url: '/diff', headers });
            expect(diff.body).toContain('Publish changes');
            const published = await app.inject({
                url: '/diff/apply',
                method: 'POST',
                headers,
                payload: new URLSearchParams({
                    publicationRevision: buildManagerDiff(
                        loadManagerStateOrEmpty(settings),
                        settings,
                    ).publicationRevision,
                }).toString(),
            });
            expect(published.statusCode).toBe(303);
            expect(
                getPersonAccess(loadManagerStateOrEmpty(settings), settings, email).activeConfirmed,
            ).toBe(true);
        } finally {
            await app.close();
        }
    });

    it('rejects stale competing saves and tokens for another email', async () => {
        const { settings, state } = fixture();
        const app = await buildApp({ settings, logger: false, now });
        try {
            const preview = previewPersonAccess(
                state,
                settings,
                email,
                [{ siteId: 'beta', scopes: ['*'] }],
                now,
            );
            const payload = new URLSearchParams({ previewToken: preview.token }).toString();
            expect(
                (
                    await app.inject({
                        url: '/people/other@example.com/save',
                        method: 'POST',
                        headers,
                        payload,
                    })
                ).statusCode,
            ).toBe(409);
            const results = await Promise.all(
                [0, 1].map(() =>
                    app.inject({ url: `/people/${email}/save`, method: 'POST', headers, payload }),
                ),
            );
            expect(results.map((result) => result.statusCode).sort()).toEqual([303, 409]);
            expect(loadManagerAuditEvents(settings)).toHaveLength(1);
        } finally {
            await app.close();
        }
    });

    it('enforces authentication and same-origin posts on new routes', async () => {
        const { settings } = fixture();
        const app = await buildApp({ settings, logger: false });
        try {
            expect((await app.inject({ url: '/people' })).headers.location).toContain('/login');
            for (const action of ['preview', 'save']) {
                const url = `/people/${email}/${action}`;
                expect(
                    (
                        await app.inject({
                            url,
                            method: 'POST',
                            payload: '',
                            headers: { ...headers, cookie: '' },
                        })
                    ).headers.location,
                ).toContain('/login');
                expect(
                    (
                        await app.inject({
                            url,
                            method: 'POST',
                            payload: '',
                            headers: { ...headers, origin: 'http://attacker.example.test' },
                        })
                    ).statusCode,
                ).toBe(403);
            }
        } finally {
            await app.close();
        }
    });

    it('freezes person writes during base drift while keeping views readable', async () => {
        const { settings, state } = fixture();
        await applyManagerState(state, settings, { now });
        const token = previewPersonAccess(
            loadManagerStateOrEmpty(settings),
            settings,
            email,
            [{ siteId: 'beta', scopes: ['*'] }],
            now,
        ).token;
        writeFileSync(
            settings.paths.baseConfigFile,
            `${readFileSync(settings.paths.baseConfigFile, 'utf8')}\n# drift\n`,
        );
        const before = readFileSync(settings.paths.stateFile, 'utf8');
        const app = await buildApp({ settings, logger: false, now });
        try {
            const page = await app.inject({ url: `/people/${email}`, headers });
            expect(page.statusCode).toBe(200);
            expect(page.body).toContain('UI write actions are frozen');
            for (const action of ['preview', 'save']) {
                expect(
                    (
                        await app.inject({
                            url: `/people/${email}/${action}`,
                            method: 'POST',
                            headers,
                            payload: new URLSearchParams({
                                site0: 'beta',
                                mode0: 'full',
                                previewToken: token,
                            }).toString(),
                        })
                    ).statusCode,
                ).toBe(409);
            }
            expect(readFileSync(settings.paths.stateFile, 'utf8')).toBe(before);
        } finally {
            await app.close();
        }
    });

    it('keeps valid draft selections after a rejected batch and escapes scope copy', async () => {
        const { settings, state } = fixture();
        state.managedSites.alpha?.scopeCatalog.push('<script>alert(1)</script>');
        saveManagerState(settings.paths.stateFile, state);
        const app = await buildApp({ settings, logger: false });
        try {
            const page = await app.inject({ url: `/people/${email}`, headers });
            expect(page.body).toContain('&lt;script&gt;alert(1)&lt;/script&gt;');
            expect(page.body).not.toContain('<script>alert(1)</script>');
            const response = await app.inject({
                url: `/people/${email}/preview`,
                method: 'POST',
                headers,
                payload: 'site0=alpha&mode0=full&site1=beta&mode1=scoped&scope1_0=missing',
            });
            expect(response.statusCode).toBe(400);
            expect(response.body).toContain('value="full" selected');
            expect(loadManagerAuditEvents(settings)).toEqual([]);
        } finally {
            await app.close();
        }
    });
});
