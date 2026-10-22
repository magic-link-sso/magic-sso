// SPDX-License-Identifier: GPL-3.0-or-later
import { createHash, randomUUID } from 'node:crypto';
import { mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createFileBrowserSsoStore } from './browserSsoFileStore.js';
import { createRedisBrowserSsoStore } from './browserSsoRedisStore.js';
import {
    createRedisSecurityStateClient,
    type RedisSecurityStateClient,
} from './redisSecurityState.js';
import {
    createBrowserSsoOpaqueValue,
    hashBrowserSsoValue,
    type BrowserSsoStore,
} from './browserSsoStore.js';

const verifier = 'dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk';
const challenge = createHash('sha256').update(verifier).digest('base64url');
const browserBinding = 'test-browser-binding';
const redirectUri = 'https://app.example.com/auth/sso/callback';
const redisUrl = process.env.MAGICSSO_TEST_REDIS_URL;

for (const adapter of ['file', 'redis']) {
    describe.skipIf(adapter === 'redis' && !redisUrl)(`browser SSO ${adapter} storage`, () => {
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
                throw new Error('Missing Redis test client');
            }
            return createRedisBrowserSsoStore({ client, keyPrefix: prefix });
        }

        beforeEach(async () => {
            directory = await mkdtemp(join(tmpdir(), 'magic-sso-browser-store-'));
            now = Date.now();
            prefix = `magic-sso-store-test-${randomUUID()}`;
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

        async function request(expiresAt = now + 60_000): Promise<string> {
            const result = await store.createRequest({
                browserBinding,
                redirectUri,
                siteId: 'app',
                state: createBrowserSsoOpaqueValue(),
                codeChallenge: challenge,
                scope: '*',
                now,
                expiresAt,
            });
            if (result.kind !== 'created') {
                throw new Error('Request rejected');
            }
            return result.requestId;
        }

        async function issued(
            sessionHandle?: string,
        ): Promise<{ code: string; handle: string; requestId: string }> {
            const handle =
                sessionHandle ??
                (
                    await store.createSession({
                        email: 'user@example.com',
                        now,
                        expiresAt: now + 300_000,
                    })
                ).handle;
            const requestId = await request();
            const result = await store.issueCode({
                requestId,
                browserBinding,
                sessionHandle: handle,
                now,
                lifetimeSeconds: 60,
            });
            if (result.kind !== 'issued') {
                throw new Error('Code not issued');
            }
            return { code: result.code, handle, requestId };
        }

        function redemption(code: string): Parameters<BrowserSsoStore['redeemCode']>[0] {
            return {
                code,
                codeVerifier: verifier,
                redirectUri,
                siteId: 'app',
                scope: '*',
                email: 'user@example.com',
                now,
            };
        }

        it('retains immutable sessions across reopening without sliding expiry', async () => {
            const created = await store.createSession({
                email: 'user@example.com',
                now,
                expiresAt: now + 30_000,
            });
            const restarted = await reopen();
            expect(await restarted.getSession(created.handle, now + 29_999)).toEqual(
                created.session,
            );
            expect(await restarted.getSession(created.handle, now + 30_000)).toBeNull();
            expect(await restarted.getSession('unknown-handle', now)).toBeNull();
        });

        it('allows exactly one valid concurrent redemption across instances', async () => {
            const { code } = await issued();
            const another = await reopen();
            const results = await Promise.all(
                Array.from({ length: 20 }, (_, i) =>
                    (i % 2 === 0 ? store : another).redeemCode(redemption(code)),
                ),
            );
            expect(results.filter((result) => result.kind === 'redeemed')).toHaveLength(1);
            expect(results.filter((result) => result.kind === 'code_rejected')).toHaveLength(19);
        });

        it.each([
            { codeVerifier: 'x'.repeat(43) },
            { codeVerifier: verifier + 'é' },
            { codeVerifier: '' },
            { redirectUri: redirectUri + '/' },
            { redirectUri: 'https://other.example.com/auth/sso/callback' },
            { siteId: 'other' },
            { scope: 'admin' },
            { email: 'other@example.com' },
        ])('does not consume a code for a wrong proof or binding: %j', async (overrides) => {
            const { code } = await issued();
            expect(await store.redeemCode({ ...redemption(code), ...overrides })).toEqual({
                kind: 'code_rejected',
            });
            expect((await store.redeemCode(redemption(code))).kind).toBe('redeemed');
        });

        it('cannot redeem codes after expiry, revocation or identity replacement', async () => {
            const expired = await issued();
            expect(
                await store.redeemCode({ ...redemption(expired.code), now: now + 60_000 }),
            ).toEqual({ kind: 'code_rejected' });
            const revoked = await issued();
            await store.revokeSession(revoked.handle, now);
            expect(await store.redeemCode(redemption(revoked.code))).toEqual({
                kind: 'session_expired',
            });
            const previous = await issued();
            const replacement = await store.createSession({
                email: 'other@example.com',
                now,
                expiresAt: now + 300_000,
                previousHandle: previous.handle,
            });
            expect(replacement.handle).not.toBe(previous.handle);
            expect(await store.getSession(previous.handle, now)).toBeNull();
            expect(await store.redeemCode(redemption(previous.code))).toEqual({
                kind: 'session_expired',
            });
            expect(await store.getSession(replacement.handle, now)).toMatchObject({
                email: 'other@example.com',
            });
        });

        it('persists launcher requests without allowing application authorization codes', async () => {
            const created = await store.createRequest({
                flow: 'launcher',
                browserBinding,
                siteId: 'magic-link-sso-launcher',
                redirectUri: 'https://sso.example.com/sso/apps',
                state: createBrowserSsoOpaqueValue(),
                codeChallenge: challenge,
                scope: '*',
                now,
                expiresAt: now + 60_000,
            });
            if (created.kind !== 'created') {
                throw new Error('Missing request');
            }
            expect((await (await reopen()).getRequest(created.requestId, now))?.flow).toBe(
                'launcher',
            );
            const session = await store.createSession({
                email: 'user@example.com',
                now,
                expiresAt: now + 300_000,
            });
            expect(
                await store.issueCode({
                    requestId: created.requestId,
                    browserBinding,
                    sessionHandle: session.handle,
                    now,
                    lifetimeSeconds: 60,
                }),
            ).toEqual({ kind: 'request_rejected' });
            expect(
                await store.bindGrant({
                    requestId: created.requestId,
                    browserBinding,
                    grantId: 'new-grant',
                    now,
                }),
            ).toBe(true);
            expect(
                await store.consumeLauncherRequest({
                    requestId: created.requestId,
                    grantId: 'old-grant',
                    now,
                }),
            ).toBe(false);
            expect(await store.getRequest(created.requestId, now)).not.toBeNull();
            const completions = await Promise.all(
                Array.from({ length: 4 }, () =>
                    store.consumeLauncherRequest({
                        requestId: created.requestId,
                        grantId: 'new-grant',
                        now,
                    }),
                ),
            );
            expect(completions.filter(Boolean)).toHaveLength(1);
            expect(await store.getRequest(created.requestId, now)).toBeNull();
        });

        it('checks the central session again after inspection', async () => {
            const { code, handle } = await issued();
            expect(await store.inspectCode(code, now)).toMatchObject({
                session: { email: 'user@example.com' },
            });
            await store.revokeSession(handle, now);
            expect(await store.redeemCode(redemption(code))).toEqual({ kind: 'session_expired' });
            expect(await store.inspectCode(code, now)).toMatchObject({ session: null });
        });

        it('caps a code at the central session absolute deadline', async () => {
            const { handle } = await store.createSession({
                email: 'user@example.com',
                now,
                expiresAt: now + 20_000,
            });
            const { code } = await issued(handle);
            expect((await store.inspectCode(code, now))?.code.expiresAt).toBe(now + 20_000);
            expect(await store.inspectCode(code, now + 20_000)).toBeNull();
        });

        it('keeps tabs and resend grants independent without extending deadlines', async () => {
            const first = await request();
            const second = await request();
            expect(
                await store.bindGrant({
                    requestId: first,
                    browserBinding: 'wrong',
                    grantId: 'a',
                    now,
                }),
            ).toBe(false);
            expect(
                await store.bindGrant({ requestId: first, browserBinding, grantId: 'a', now }),
            ).toBe(true);
            expect(
                await store.bindGrant({ requestId: second, browserBinding, grantId: 'b', now }),
            ).toBe(true);
            expect(
                await store.bindGrant({
                    requestId: first,
                    browserBinding,
                    grantId: 'c',
                    now: now + 10_000,
                }),
            ).toBe(true);
            expect((await store.getRequest(first, now))?.expiresAt).toBe(now + 60_000);
            const { handle } = await store.createSession({
                email: 'user@example.com',
                now,
                expiresAt: now + 300_000,
            });
            const input = { browserBinding, sessionHandle: handle, now, lifetimeSeconds: 60 };
            expect(await store.issueCode({ ...input, requestId: first, grantId: 'a' })).toEqual({
                kind: 'request_rejected',
            });
            expect(await store.issueCode({ ...input, requestId: first, grantId: 'b' })).toEqual({
                kind: 'request_rejected',
            });
            expect(
                (await store.issueCode({ ...input, requestId: second, grantId: 'b' })).kind,
            ).toBe('issued');
            expect((await store.issueCode({ ...input, requestId: first, grantId: 'c' })).kind).toBe(
                'issued',
            );
        });

        it('can complete each request only once and never from a different browser', async () => {
            const requestId = await request();
            const { handle } = await store.createSession({
                email: 'user@example.com',
                now,
                expiresAt: now + 300_000,
            });
            const input = {
                requestId,
                browserBinding,
                sessionHandle: handle,
                now,
                lifetimeSeconds: 60,
            };
            expect(await store.issueCode({ ...input, browserBinding: 'wrong' })).toEqual({
                kind: 'request_rejected',
            });
            const results = await Promise.all([store.issueCode(input), store.issueCode(input)]);
            expect(results.filter((result) => result.kind === 'issued')).toHaveLength(1);
            expect(results.filter((result) => result.kind === 'request_rejected')).toHaveLength(1);
        });

        it('rejects expired request verification and frees capacity after expiration', async () => {
            const ids: string[] = [];
            for (let i = 0; i < 32; i += 1) {
                ids.push(await request());
            }
            const input = {
                browserBinding,
                redirectUri,
                siteId: 'app',
                state: createBrowserSsoOpaqueValue(),
                codeChallenge: challenge,
                scope: '*',
                now,
                expiresAt: now + 60_000,
            };
            expect(await store.createRequest(input)).toEqual({ kind: 'request_limit' });
            const first = ids[0];
            if (!first) {
                throw new Error('Missing first request');
            }
            expect(
                await store.bindGrant({
                    requestId: first,
                    browserBinding,
                    grantId: 'a',
                    now: now + 60_000,
                }),
            ).toBe(false);
            expect(await store.getRequest(first, now + 60_000)).toBeNull();
            expect(
                (
                    await store.createRequest({
                        ...input,
                        now: now + 60_000,
                        expiresAt: now + 120_000,
                    })
                ).kind,
            ).toBe('created');
        });

        it('does not persist raw browser handles, request IDs, grants, codes, or verifiers', async () => {
            const { code, handle, requestId } = await issued();
            const pendingId = await request();
            await store.bindGrant({
                requestId: pendingId,
                browserBinding,
                grantId: 'raw-secret-grant',
                now,
            });
            if (adapter === 'file') {
                const contents = await readFile(join(directory, 'browser-sso-v1.json'), 'utf8');
                for (const raw of [
                    code,
                    handle,
                    requestId,
                    pendingId,
                    browserBinding,
                    verifier,
                    'raw-secret-grant',
                ]) {
                    expect(contents).not.toContain(raw);
                }
                expect(contents).toContain(hashBrowserSsoValue(handle));
                expect((await stat(directory)).mode & 0o777).toBe(0o700);
                expect((await stat(join(directory, 'browser-sso-v1.json'))).mode & 0o777).toBe(
                    0o600,
                );
            } else if (client) {
                const keyPrefix = `${prefix}:browser-sso:{${hashBrowserSsoValue(prefix)}}:`;
                const sessionKey = `${keyPrefix}session:${hashBrowserSsoValue(handle)}`;
                const codeKey = `${keyPrefix}code:${hashBrowserSsoValue(code)}`;
                const contents = `${await client.get(sessionKey)}${await client.get(codeKey)}`;
                for (const raw of [code, handle, requestId, browserBinding, verifier]) {
                    expect(contents).not.toContain(raw);
                }
                const ttl = await client.eval("return redis.call('PTTL', KEYS[1])", 1, codeKey);
                expect(typeof ttl).toBe('number');
                expect(ttl).toBeGreaterThan(0);
                // Check the absolute deadline written by PXAT: Docker and the
                // test host need not have exactly the same wall clock.
                const deadline = await client.eval(
                    "return redis.call('PEXPIRETIME', KEYS[1])",
                    1,
                    codeKey,
                );
                expect(deadline).toBe(now + 60_000);
            }
        });

        it('prunes expired records and rejects invalid lifetimes', async () => {
            await issued();
            await store.prune(now + 300_000);
            if (adapter === 'file') {
                expect(
                    JSON.parse(await readFile(join(directory, 'browser-sso-v1.json'), 'utf8')),
                ).toEqual({ version: 1, records: {} });
            }
            await expect(
                store.createSession({ email: 'user@example.com', now, expiresAt: now }),
            ).rejects.toThrow('future');
            await expect(
                store.createSession({ email: 'invalid', now, expiresAt: now + 100 }),
            ).rejects.toThrow();
        });
    });
}

describe('browser SSO dependency failures', () => {
    it('surfaces corrupt file state instead of substituting a missing session', async () => {
        const directory = await mkdtemp(join(tmpdir(), 'magic-sso-corrupt-'));
        try {
            await writeFile(join(directory, 'browser-sso-v1.json'), '{corrupt');
            await expect(createFileBrowserSsoStore({ directory })).rejects.toThrow();
        } finally {
            await rm(directory, { force: true, recursive: true });
        }
    });

    it('surfaces Redis failures and invalid commit replies', async () => {
        const client: RedisSecurityStateClient = {
            connect: vi.fn(async () => undefined),
            disconnect: vi.fn(),
            get: vi.fn(async () => {
                throw new Error('Redis unavailable');
            }),
            eval: vi.fn(async () => 'bad reply'),
            ping: vi.fn(async () => 'PONG'),
            quit: vi.fn(async () => 'OK'),
            set: vi.fn(async (): Promise<'OK'> => 'OK'),
        };
        const store = createRedisBrowserSsoStore({ client, keyPrefix: 'test' });
        await expect(store.getSession('opaque', Date.now())).rejects.toThrow('Redis unavailable');
        vi.mocked(client.get).mockResolvedValue(null);
        await expect(store.getSession('opaque', Date.now())).rejects.toThrow('Invalid Redis');
        vi.mocked(client.eval).mockResolvedValue(0);
        await expect(store.getSession('opaque', Date.now())).rejects.toThrow('contention limit');
    });
});

describe('browser SSO file capacity', () => {
    let directory: string;
    const now = 1_800_000_000_000;

    beforeEach(async () => {
        directory = await mkdtemp(join(tmpdir(), 'magic-sso-browser-capacity-'));
    });

    afterEach(async () => {
        await rm(directory, { recursive: true, force: true });
    });

    function requestInput(browserBinding: string, expiresAt: number) {
        return {
            browserBinding,
            redirectUri,
            siteId: 'app',
            state: createBrowserSsoOpaqueValue(),
            codeChallenge: challenge,
            scope: '*',
            now,
            expiresAt,
        };
    }

    it('caps aggregate requests across fresh bindings and frees expired capacity', async () => {
        const store = await createFileBrowserSsoStore({ directory, maxRecords: 6 });
        const first = await store.createRequest(requestInput('browser-1', now + 1_000));
        const second = await store.createRequest(requestInput('browser-2', now + 60_000));
        expect(first.kind).toBe('created');
        expect(second.kind).toBe('created');
        const beforeRejection = await readFile(join(directory, 'browser-sso-v1.json'), 'utf8');

        expect(await store.createRequest(requestInput('browser-3', now + 60_000))).toEqual({
            kind: 'request_limit',
        });
        expect(await readFile(join(directory, 'browser-sso-v1.json'), 'utf8')).toBe(
            beforeRejection,
        );

        expect(
            (
                await store.createRequest({
                    ...requestInput('browser-3', now + 60_000),
                    now: now + 1_000,
                })
            ).kind,
        ).toBe('created');
    });

    it('rejects aggregate growth but permits replacement at capacity', async () => {
        const store = await createFileBrowserSsoStore({ directory, maxRecords: 1 });
        const first = await store.createSession({
            email: 'first@example.com',
            now,
            expiresAt: now + 60_000,
        });
        await expect(
            store.createSession({
                email: 'second@example.com',
                now,
                expiresAt: now + 60_000,
            }),
        ).rejects.toThrow('capacity');

        const replacement = await store.createSession({
            email: 'second@example.com',
            now,
            expiresAt: now + 60_000,
            previousHandle: first.handle,
        });
        const reopened = await createFileBrowserSsoStore({ directory, maxRecords: 1 });
        expect(await reopened.getSession(first.handle, now)).toBeNull();
        expect(await reopened.getSession(replacement.handle, now)).toEqual(replacement.session);
    });
});
