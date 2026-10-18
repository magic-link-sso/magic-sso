// SPDX-License-Identifier: GPL-3.0-or-later
import { createHash, randomUUID } from 'node:crypto';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createFileBrowserSsoStore } from './browserSsoFileStore.js';
import { createRedisBrowserSsoStore } from './browserSsoRedisStore.js';
import {
    createRedisSecurityStateClient,
    type RedisSecurityStateClient,
} from './redisSecurityState.js';
import {
    createBrowserSsoOpaqueValue,
    type BrowserSsoStore,
    type BootstrapRequestProof,
} from './browserSsoStore.js';
const verifier = 'dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk';
const challenge = createHash('sha256').update(verifier).digest('base64url');
const accessTokenHash = createHash('sha256').update('synthetic-app-jwt').digest('base64url');
const state = createBrowserSsoOpaqueValue();
const redirectUri = 'https://app.example.com/sso/callback';
const binding = 'synthetic-original-browser-binding';
const redisUrl = process.env.MAGICSSO_TEST_REDIS_URL;
for (const adapter of ['file', 'redis']) {
    describe.skipIf(adapter === 'redis' && !redisUrl)(
        `app-owned bootstrap ${adapter} store`,
        () => {
            let directory: string;
            let store: BrowserSsoStore;
            let client: RedisSecurityStateClient | undefined;
            let prefix: string;
            let now: number;
            async function reopen(): Promise<BrowserSsoStore> {
                if (adapter === 'file') {
                    return createFileBrowserSsoStore({ directory });
                }
                if (!client) {
                    throw new Error('Missing test Redis client');
                }
                return createRedisBrowserSsoStore({ client, keyPrefix: prefix });
            }
            beforeEach(async () => {
                directory = await mkdtemp(join(tmpdir(), 'magic-sso-bootstrap-store-'));
                now = Date.now();
                prefix = `magic-sso-bootstrap-store-${randomUUID()}`;
                if (adapter === 'redis' && redisUrl) {
                    client = createRedisSecurityStateClient(redisUrl);
                    await client.connect();
                }
                store = await reopen();
            });
            afterEach(async () => {
                await client?.quit();
                client = undefined;
                await rm(directory, { recursive: true, force: true });
            });
            async function request(
                flow: 'app-owned' | null = 'app-owned',
            ): Promise<BootstrapRequestProof> {
                const result = await store.createRequest({
                    ...(flow === null ? {} : { flow }),
                    browserBinding: binding,
                    siteId: 'app',
                    redirectUri,
                    codeChallenge: challenge,
                    state,
                    scope: '*',
                    now,
                    expiresAt: now + 60_000,
                });
                if (result.kind !== 'created') {
                    throw new Error('Request rejected');
                }
                return {
                    requestId: result.requestId,
                    codeVerifier: verifier,
                    redirectUri,
                    siteId: 'app',
                    now,
                };
            }
            async function issue(proof?: BootstrapRequestProof): Promise<string> {
                const current = proof ?? (await request());
                expect(
                    await store.bindBootstrapGrant({
                        ...current,
                        scope: '*',
                        grantId: 'current-grant',
                    }),
                ).toBe(true);
                const result = await store.issueBootstrapTicket({
                    ...current,
                    scope: '*',
                    grantId: 'current-grant',
                    email: 'owner@example.com',
                    accessTokenHash,
                    lifetimeSeconds: 60,
                });
                if (result.kind !== 'issued') {
                    throw new Error('Ticket rejected');
                }
                return result.ticket;
            }
            function redemption(
                ticket: string,
            ): Parameters<BrowserSsoStore['redeemBootstrapTicket']>[0] {
                return {
                    ticket,
                    redirectUri,
                    state,
                    siteId: 'app',
                    browserBinding: binding,
                    now,
                    sessionExpiresAt: now + 300_000,
                };
            }
            it('requires app-owned flow before inspecting or binding a grant', async () => {
                const proof = await request(null);
                expect(await store.inspectBootstrapRequest(proof)).toBeNull();
                expect(
                    await store.bindBootstrapGrant({ ...proof, scope: '*', grantId: 'grant' }),
                ).toBe(false);
                expect(
                    await store.issueBootstrapTicket({
                        ...proof,
                        scope: '*',
                        grantId: 'grant',
                        email: 'owner@example.com',
                        accessTokenHash,
                        lifetimeSeconds: 60,
                    }),
                ).toEqual({ kind: 'request_rejected' });
                expect(await store.getRequest(proof.requestId, now)).not.toBeNull();
            });
            it.each([
                { codeVerifier: 'x'.repeat(43) },
                { codeVerifier: '!' + verifier },
                { redirectUri: 'https://app.example.com/other' },
                { siteId: 'another-app' },
            ])('does not mutate a request on wrong proof %j', async (override) => {
                const proof = await request();
                expect(await store.inspectBootstrapRequest({ ...proof, ...override })).toBeNull();
                expect(
                    await store.bindBootstrapGrant({
                        ...proof,
                        ...override,
                        scope: '*',
                        grantId: 'attacker-grant',
                    }),
                ).toBe(false);
                expect((await store.getRequest(proof.requestId, now))?.grantHash).toBeNull();
                expect(await store.inspectBootstrapRequest(proof)).not.toBeNull();
            });
            it('rotates the grant without extending the request and refuses older email proof', async () => {
                const proof = await request();
                expect(
                    await store.bindBootstrapGrant({ ...proof, scope: '*', grantId: 'old' }),
                ).toBe(true);
                expect(
                    await store.bindBootstrapGrant({
                        ...proof,
                        scope: '*',
                        grantId: 'new',
                        now: now + 30_000,
                    }),
                ).toBe(true);
                expect((await store.getRequest(proof.requestId, now))?.expiresAt).toBe(
                    now + 60_000,
                );
                const input = {
                    ...proof,
                    email: 'owner@example.com',
                    accessTokenHash,
                    lifetimeSeconds: 120,
                    now: now + 30_000,
                };
                expect(
                    await store.issueBootstrapTicket({ ...input, scope: '*', grantId: 'old' }),
                ).toEqual({
                    kind: 'request_rejected',
                });
                const issued = await store.issueBootstrapTicket({
                    ...input,
                    scope: '*',
                    grantId: 'new',
                });
                if (issued.kind !== 'issued') {
                    throw new Error('Ticket rejected');
                }
                expect(issued.record.expiresAt).toBe(now + 60_000);
                expect(await store.getRequest(proof.requestId, now)).toBeNull();
                await expect(
                    (await reopen()).getBootstrapTicket(issued.ticket, now),
                ).resolves.toEqual(issued.record);
                if (adapter === 'file') {
                    const persisted = await readFile(
                        join(directory, 'browser-sso-v1.json'),
                        'utf8',
                    );
                    expect(persisted).not.toContain(issued.ticket);
                    expect(persisted).not.toContain(binding);
                }
            });
            it('issues exactly one ticket from concurrent verification completions', async () => {
                const proof = await request();
                await store.bindBootstrapGrant({ ...proof, scope: '*', grantId: 'grant' });
                const input = {
                    ...proof,
                    scope: '*',
                    grantId: 'grant',
                    email: 'owner@example.com',
                    accessTokenHash,
                    lifetimeSeconds: 60,
                };
                const second = await reopen();
                const results = await Promise.all([
                    store.issueBootstrapTicket(input),
                    second.issueBootstrapTicket(input),
                ]);
                expect(results.filter((result) => result.kind === 'issued')).toHaveLength(1);
                expect(results.filter((result) => result.kind === 'request_rejected')).toHaveLength(
                    1,
                );
            });
            it('rejects a grant for a different scope without consuming the request', async () => {
                const proof = await request();
                expect(
                    await store.bindBootstrapGrant({
                        ...proof,
                        grantId: 'grant',
                        scope: 'reports',
                    }),
                ).toBe(false);
                expect(
                    await store.bindBootstrapGrant({ ...proof, grantId: 'grant', scope: '*' }),
                ).toBe(true);
                expect(
                    await store.issueBootstrapTicket({
                        ...proof,
                        grantId: 'grant',
                        scope: 'reports',
                        email: 'owner@example.com',
                        accessTokenHash,
                        lifetimeSeconds: 60,
                    }),
                ).toEqual({ kind: 'request_rejected' });
                expect(await store.getRequest(proof.requestId, now)).not.toBeNull();
            });
            it.each([
                { redirectUri: 'https://other.example.com/sso/callback' },
                { state: 'z'.repeat(43) },
                { siteId: 'other' },
            ])('does not burn a ticket on mismatched redemption context %j', async (override) => {
                const ticket = await issue();
                expect(
                    await store.redeemBootstrapTicket({ ...redemption(ticket), ...override }),
                ).toEqual({ kind: 'ticket_rejected' });
                expect(await store.getBootstrapTicket(ticket, now)).not.toBeNull();
                expect((await store.redeemBootstrapTicket(redemption(ticket))).kind).toBe(
                    'redeemed',
                );
            });
            it('requires confirmation in a different browser without burning the ticket or prior identity', async () => {
                const previous = await store.createSession({
                    email: 'previous@example.com',
                    now: now - 1000,
                    expiresAt: now + 300_000,
                });
                const ticket = await issue();
                const input = {
                    ...redemption(ticket),
                    browserBinding: 'different-browser',
                    previousHandle: previous.handle,
                };
                expect(await store.redeemBootstrapTicket(input)).toEqual({
                    kind: 'confirmation_required',
                });
                expect(await store.getBootstrapTicket(ticket, now)).not.toBeNull();
                expect(await store.getSession(previous.handle, now)).not.toBeNull();
                const confirmed = await store.redeemBootstrapTicket({
                    ...input,
                    confirmedAccountChange: true,
                });
                expect(confirmed.kind).toBe('redeemed');
                expect(await store.getSession(previous.handle, now)).toBeNull();
                expect(
                    await store.redeemBootstrapTicket({ ...input, confirmedAccountChange: true }),
                ).toEqual({ kind: 'ticket_rejected' });
            });
            it('does not silently replace a newer different central identity', async () => {
                const ticket = await issue();
                const newer = await store.createSession({
                    email: 'newer@example.com',
                    now: now + 1,
                    expiresAt: now + 300_000,
                });
                const input = { ...redemption(ticket), now: now + 2, previousHandle: newer.handle };
                expect(await store.redeemBootstrapTicket(input)).toEqual({
                    kind: 'confirmation_required',
                });
                expect(await store.getSession(newer.handle, now + 2)).not.toBeNull();
                expect(
                    (await store.redeemBootstrapTicket({ ...input, confirmedAccountChange: true }))
                        .kind,
                ).toBe('redeemed');
            });
            it('atomically replaces the original identity and invalidates its outstanding code', async () => {
                const previous = await store.createSession({
                    email: 'previous@example.com',
                    now: now - 1000,
                    expiresAt: now + 300_000,
                });
                const pending = await request();
                const code = await store.issueCode({
                    requestId: pending.requestId,
                    browserBinding: binding,
                    sessionHandle: previous.handle,
                    now,
                    lifetimeSeconds: 60,
                });
                if (code.kind !== 'issued') {
                    throw new Error('Code rejected');
                }
                const ticket = await issue();
                const completed = await store.redeemBootstrapTicket({
                    ...redemption(ticket),
                    previousHandle: previous.handle,
                    confirmedAccountChange: true,
                });
                if (completed.kind !== 'redeemed') {
                    throw new Error('Ticket rejected');
                }
                expect(completed.session.email).toBe('owner@example.com');
                expect((await store.getSession(completed.handle, now))?.email).toBe(
                    'owner@example.com',
                );
                expect(
                    await store.redeemCode({
                        code: code.code,
                        codeVerifier: verifier,
                        redirectUri,
                        siteId: 'app',
                        scope: '*',
                        email: 'previous@example.com',
                        now,
                    }),
                ).toEqual({ kind: 'session_expired' });
            });
            it('redeems once across independent file/Redis store instances', async () => {
                const ticket = await issue();
                const second = await reopen();
                const results = await Promise.all([
                    store.redeemBootstrapTicket(redemption(ticket)),
                    second.redeemBootstrapTicket(redemption(ticket)),
                ]);
                expect(results.filter((result) => result.kind === 'redeemed')).toHaveLength(1);
                expect(results.filter((result) => result.kind === 'ticket_rejected')).toHaveLength(
                    1,
                );
                expect(await store.getBootstrapTicket(ticket, now)).toBeNull();
            });
            it('central logout invalidates earlier tickets even after new requests use the same binding', async () => {
                const ticket = await issue();
                await store.endBrowserSession({ browserBinding: binding, now: now + 1 });
                await request();
                expect(
                    await store.redeemBootstrapTicket({
                        ...redemption(ticket),
                        now: now + 2,
                        confirmedAccountChange: true,
                    }),
                ).toEqual({ kind: 'ticket_rejected' });
                const fresh = await issue();
                expect(
                    (await store.redeemBootstrapTicket({ ...redemption(fresh), now: now + 3 }))
                        .kind,
                ).toBe('redeemed');
            });
            it('central logout blocks delayed session cookies and their pending authorization codes', async () => {
                const ticket = await issue();
                const completed = await store.redeemBootstrapTicket(redemption(ticket));
                if (completed.kind !== 'redeemed') {
                    throw new Error('Ticket rejected');
                }
                const pending = await request(null);
                const code = await store.issueCode({
                    requestId: pending.requestId,
                    browserBinding: binding,
                    sessionHandle: completed.handle,
                    now,
                    lifetimeSeconds: 60,
                });
                if (code.kind !== 'issued') {
                    throw new Error('Code rejected');
                }
                // Sign-out may arrive before the browser has received the new central handle.
                await store.endBrowserSession({ browserBinding: binding, now: now + 1 });
                expect(await store.getSession(completed.handle, now + 2)).toBeNull();
                expect((await store.inspectCode(code.code, now + 2))?.session).toBeNull();
                expect(
                    await store.redeemCode({
                        code: code.code,
                        codeVerifier: verifier,
                        redirectUri,
                        siteId: 'app',
                        scope: '*',
                        email: 'owner@example.com',
                        now: now + 2,
                    }),
                ).toEqual({ kind: 'session_expired' });
            });
            it('retains a bound session after its original short request deadline', async () => {
                const ticket = await issue();
                const completed = await store.redeemBootstrapTicket(redemption(ticket));
                if (completed.kind !== 'redeemed') {
                    throw new Error('Ticket rejected');
                }
                expect(await store.getSession(completed.handle, now + 120_000)).not.toBeNull();
                await store.endBrowserSession({ handle: completed.handle, now: now + 120_001 });
                expect(await store.getSession(completed.handle, now + 120_002)).toBeNull();
            });
            it('a stale handle cannot revoke a newer identity on another binding', async () => {
                const ticket = await issue();
                const stale = await store.redeemBootstrapTicket(redemption(ticket));
                if (stale.kind !== 'redeemed') {
                    throw new Error('Ticket rejected');
                }
                await store.endBrowserSession({ browserBinding: binding, now: now + 1 });
                const freshTicket = await issue();
                const fresh = await store.redeemBootstrapTicket(redemption(freshTicket));
                if (fresh.kind !== 'redeemed') {
                    throw new Error('Ticket rejected');
                }
                await store.endBrowserSession({
                    handle: stale.handle,
                    browserBinding: 'unrelated-browser',
                    now: now + 2,
                });
                expect(await store.getSession(fresh.handle, now + 3)).not.toBeNull();
            });
            it('enforces absolute request and ticket deadlines', async () => {
                const proof = await request();
                expect(
                    await store.bindBootstrapGrant({
                        ...proof,
                        scope: '*',
                        grantId: 'expired',
                        now: now + 60_000,
                    }),
                ).toBe(false);
                const ticket = await issue();
                expect(
                    await store.redeemBootstrapTicket({ ...redemption(ticket), now: now + 60_000 }),
                ).toEqual({ kind: 'ticket_rejected' });
                expect(await store.getBootstrapTicket(ticket, now + 60_000)).toBeNull();
            });
            it('rejects malformed hashes or unbounded ticket lifetimes without deleting the request', async () => {
                const proof = await request();
                await store.bindBootstrapGrant({ ...proof, scope: '*', grantId: 'grant' });
                const input = {
                    ...proof,
                    scope: '*',
                    grantId: 'grant',
                    email: 'owner@example.com',
                    accessTokenHash,
                    lifetimeSeconds: 60,
                };
                await expect(
                    store.issueBootstrapTicket({ ...input, accessTokenHash: 'invalid' }),
                ).rejects.toThrow();
                for (const lifetimeSeconds of [0, 121, 30.5]) {
                    await expect(
                        store.issueBootstrapTicket({ ...input, lifetimeSeconds }),
                    ).rejects.toThrow();
                }
                expect(await store.getRequest(proof.requestId, now)).not.toBeNull();
            });
        },
    );
}
