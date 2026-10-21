// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 Wojciech Polak

import { createHash, randomBytes } from 'node:crypto';
import { z } from 'zod';

const timestamp = z.number().int().nonnegative();
const digest = z.string().regex(/^[a-f0-9]{64}$/);
const sessionSchema = z
    .object({
        kind: z.literal('session'),
        bootstrapBindingHash: digest.optional(),
        bootstrapEpoch: timestamp.optional(),
        id: digest,
        email: z.string().email(),
        createdAt: timestamp,
        expiresAt: timestamp,
    })
    .strict();
const requestSchema = z
    .object({
        kind: z.literal('request'),
        flow: z.enum(['app-owned', 'launcher']).optional(),
        id: digest,
        bindingHash: digest,
        siteId: z.string().min(1),
        redirectUri: z.string().url(),
        state: z.string().regex(/^[A-Za-z0-9_-]{43}$/),
        codeChallenge: z.string().regex(/^[A-Za-z0-9_-]{43}$/),
        scope: z.string().min(1).max(256),
        grantHash: digest.nullable(),
        createdAt: timestamp,
        expiresAt: timestamp,
    })
    .strict();
const codeSchema = z
    .object({
        kind: z.literal('code'),
        id: digest,
        sessionId: digest,
        siteId: z.string().min(1),
        redirectUri: z.string().url(),
        scope: z.string().min(1).max(256),
        codeChallenge: z.string().regex(/^[A-Za-z0-9_-]{43}$/),
        createdAt: timestamp,
        expiresAt: timestamp,
    })
    .strict();
const bindingSchema = z
    .object({
        kind: z.literal('binding'),
        bootstrapEpoch: timestamp.optional(),
        requests: z.array(digest).max(32),
        expiresAt: timestamp,
    })
    .strict();

const bootstrapSchema = z
    .object({
        kind: z.literal('bootstrap'),
        bootstrapEpoch: timestamp,
        id: digest,
        requestHash: digest,
        bindingHash: digest,
        siteId: z.string().min(1),
        redirectUri: z.string().url(),
        scope: z.string().min(1).max(256),
        state: z.string().regex(/^[A-Za-z0-9_-]{43}$/),
        email: z.string().email(),
        accessTokenHash: z.string().regex(/^[A-Za-z0-9_-]{43}$/),
        createdAt: timestamp,
        expiresAt: timestamp,
    })
    .strict();

export const browserSsoRecordSchema = z.discriminatedUnion('kind', [
    sessionSchema,
    requestSchema,
    codeSchema,
    bindingSchema,
    bootstrapSchema,
]);
export type BrowserSsoRecord = z.infer<typeof browserSsoRecordSchema>;
export type StoredBootstrapTicket = z.infer<typeof bootstrapSchema>;
export type CentralBrowserSession = z.infer<typeof sessionSchema>;
export type StoredAuthorizationRequest = z.infer<typeof requestSchema>;
export type StoredAuthorizationCode = z.infer<typeof codeSchema>;

/** All reads (including absent records) participate in atomic commit validation. */
export interface BrowserSsoTransaction {
    get(key: string): Promise<BrowserSsoRecord | null>;
    /** Optional aggregate admission control for backends with shared snapshot limits. */
    hasRequestCapacity?(additionalRecords: number): Promise<boolean>;
    set(key: string, value: BrowserSsoRecord | null): Promise<void>;
}

export interface BrowserSsoBackend {
    run<T>(now: number, operation: (transaction: BrowserSsoTransaction) => Promise<T>): Promise<T>;
}

export interface CreateAuthorizationRequest {
    flow?: 'app-owned' | 'launcher';
    browserBinding: string;
    siteId: string;
    redirectUri: string;
    state: string;
    codeChallenge: string;
    scope: string;
    now: number;
    expiresAt: number;
}

export interface BootstrapRequestProof {
    requestId: string;
    codeVerifier: string;
    redirectUri: string;
    siteId: string;
    now: number;
}

export interface BrowserSsoStore {
    consumeLauncherRequest(input: {
        requestId: string;
        grantId: string;
        now: number;
    }): Promise<boolean>;
    endBrowserSession(input: {
        handle?: string;
        browserBinding?: string;
        now: number;
    }): Promise<void>;

    inspectBootstrapRequest(
        input: BootstrapRequestProof,
    ): Promise<StoredAuthorizationRequest | null>;
    bindBootstrapGrant(
        input: BootstrapRequestProof & { grantId: string; scope: string },
    ): Promise<boolean>;
    issueBootstrapTicket(
        input: BootstrapRequestProof & {
            grantId: string;
            scope: string;
            email: string;
            accessTokenHash: string;
            lifetimeSeconds: number;
        },
    ): Promise<
        | { kind: 'issued'; ticket: string; record: StoredBootstrapTicket }
        | { kind: 'request_rejected' }
    >;
    getBootstrapTicket(ticket: string, now: number): Promise<StoredBootstrapTicket | null>;
    redeemBootstrapTicket(input: {
        ticket: string;
        redirectUri: string;
        state: string;
        siteId: string;
        browserBinding: string;
        now: number;
        sessionExpiresAt: number;
        previousHandle?: string;
        confirmedAccountChange?: boolean;
    }): Promise<
        | {
              kind: 'redeemed';
              ticket: StoredBootstrapTicket;
              handle: string;
              session: CentralBrowserSession;
          }
        | { kind: 'ticket_rejected' | 'confirmation_required' }
    >;

    createSession(input: {
        email: string;
        now: number;
        expiresAt: number;
        previousHandle?: string;
    }): Promise<{ handle: string; session: CentralBrowserSession }>;
    getSession(handle: string, now: number): Promise<CentralBrowserSession | null>;
    revokeSession(handle: string, now: number): Promise<void>;
    createRequest(
        input: CreateAuthorizationRequest,
    ): Promise<
        | { kind: 'created'; requestId: string; request: StoredAuthorizationRequest }
        | { kind: 'request_limit' }
    >;
    getRequest(requestId: string, now: number): Promise<StoredAuthorizationRequest | null>;
    bindGrant(input: {
        requestId: string;
        browserBinding: string;
        grantId: string;
        now: number;
    }): Promise<boolean>;
    issueCode(input: {
        requestId: string;
        browserBinding: string;
        sessionHandle: string;
        grantId?: string;
        now: number;
        lifetimeSeconds: number;
    }): Promise<
        | { kind: 'issued'; code: string; request: StoredAuthorizationRequest }
        | { kind: 'request_rejected' | 'session_expired' }
    >;
    inspectCode(
        code: string,
        now: number,
    ): Promise<{
        code: StoredAuthorizationCode;
        session: CentralBrowserSession | null;
    } | null>;
    redeemCode(input: {
        code: string;
        codeVerifier: string;
        redirectUri: string;
        siteId: string;
        scope: string;
        email: string;
        now: number;
    }): Promise<
        | { kind: 'redeemed'; session: CentralBrowserSession; code: StoredAuthorizationCode }
        | { kind: 'code_rejected' | 'session_expired' }
    >;
    prune(now: number): Promise<void>;
}

/** Opaque browser values are never persisted, including in Redis key names. */
export function hashBrowserSsoValue(value: string): string {
    return createHash('sha256').update(value).digest('hex');
}

export function createBrowserSsoOpaqueValue(): string {
    return randomBytes(32).toString('base64url');
}

function key(kind: BrowserSsoRecord['kind'], id: string): string {
    return `${kind}:${id}`;
}

function requireFutureExpiry(now: number, expiresAt: number): void {
    timestamp.parse(now);
    timestamp.parse(expiresAt);
    if (expiresAt <= now) {
        throw new Error('Browser SSO record must expire in the future.');
    }
}

async function readBootstrapRequest(
    tx: BrowserSsoTransaction,
    input: BootstrapRequestProof,
): Promise<StoredAuthorizationRequest | null> {
    const request = await tx.get(key('request', hashBrowserSsoValue(input.requestId)));
    if (
        request?.kind !== 'request' ||
        request.flow !== 'app-owned' ||
        request.siteId !== input.siteId ||
        request.redirectUri !== input.redirectUri ||
        !/^[A-Za-z0-9._~-]{43,128}$/u.test(input.codeVerifier) ||
        request.codeChallenge !==
            createHash('sha256').update(input.codeVerifier).digest('base64url')
    ) {
        return null;
    }
    return request;
}

async function readActiveSession(
    tx: BrowserSsoTransaction,
    id: string,
): Promise<CentralBrowserSession | null> {
    const session = await tx.get(key('session', id));
    if (session?.kind !== 'session') {
        return null;
    }
    if (session.bootstrapBindingHash !== undefined) {
        const binding = await tx.get(key('binding', session.bootstrapBindingHash));
        if (
            binding?.kind !== 'binding' ||
            (binding.bootstrapEpoch ?? 0) !== (session.bootstrapEpoch ?? 0)
        ) {
            return null;
        }
    }
    return session;
}

async function readRedeemableBootstrap(
    tx: BrowserSsoTransaction,
    input: Parameters<BrowserSsoStore['redeemBootstrapTicket']>[0],
): Promise<{
    ticketKey: string;
    ticket: StoredBootstrapTicket;
    originalBinding: z.infer<typeof bindingSchema>;
} | null> {
    const ticketKey = key('bootstrap', hashBrowserSsoValue(input.ticket));
    const ticket = await tx.get(ticketKey);
    if (
        ticket?.kind !== 'bootstrap' ||
        ticket.redirectUri !== input.redirectUri ||
        ticket.state !== input.state ||
        ticket.siteId !== input.siteId
    ) {
        return null;
    }
    const originalBinding = await tx.get(key('binding', ticket.bindingHash));
    if (
        originalBinding?.kind !== 'binding' ||
        (originalBinding.bootstrapEpoch ?? 0) !== ticket.bootstrapEpoch
    ) {
        return null;
    }
    return { ticketKey, ticket, originalBinding };
}

export function createBrowserSsoStore(backend: BrowserSsoBackend): BrowserSsoStore {
    return {
        async consumeLauncherRequest(input) {
            return backend.run(input.now, async (tx) => {
                const requestKey = key('request', hashBrowserSsoValue(input.requestId));
                const request = await tx.get(requestKey);
                if (
                    request?.kind !== 'request' ||
                    request.flow !== 'launcher' ||
                    request.grantHash !== hashBrowserSsoValue(input.grantId)
                ) {
                    return false;
                }
                await tx.set(requestKey, null);
                return true;
            });
        },
        async endBrowserSession(input) {
            await backend.run(input.now, async (tx) => {
                const bindings = new Set<string>();
                if (input.browserBinding !== undefined) {
                    bindings.add(hashBrowserSsoValue(input.browserBinding));
                }
                if (input.handle !== undefined) {
                    const sessionKey = key('session', hashBrowserSsoValue(input.handle));
                    const session = await readActiveSession(tx, hashBrowserSsoValue(input.handle));
                    if (session?.kind === 'session' && session.bootstrapBindingHash !== undefined) {
                        bindings.add(session.bootstrapBindingHash);
                    }
                    await tx.set(sessionKey, null);
                }
                for (const hash of bindings) {
                    const bindingKey = key('binding', hash);
                    const binding = await tx.get(bindingKey);
                    // Hosted-only deployments keep their existing storage representation.
                    // Ticket issuance marks bindings that need bootstrap cancellation.
                    if (binding?.kind !== 'binding' || binding.bootstrapEpoch === undefined) {
                        continue;
                    }
                    await tx.set(bindingKey, {
                        kind: 'binding',
                        requests: binding?.kind === 'binding' ? binding.requests : [],
                        bootstrapEpoch:
                            (binding?.kind === 'binding' ? (binding.bootstrapEpoch ?? 0) : 0) + 1,
                        // Retain revocation generations through the maximum central-session deadline.
                        expiresAt: Math.max(
                            binding?.expiresAt ?? 0,
                            input.now + 86_400_000 + 30_000,
                        ),
                    });
                }
            });
        },
        async inspectBootstrapRequest(input) {
            return backend.run(input.now, (tx) => readBootstrapRequest(tx, input));
        },
        async bindBootstrapGrant(input) {
            return backend.run(input.now, async (tx) => {
                const request = await readBootstrapRequest(tx, input);
                if (!request || request.scope !== input.scope) {
                    return false;
                }
                await tx.set(key('request', request.id), {
                    ...request,
                    grantHash: hashBrowserSsoValue(input.grantId),
                });
                return true;
            });
        },
        async issueBootstrapTicket(input) {
            if (
                !Number.isInteger(input.lifetimeSeconds) ||
                input.lifetimeSeconds < 1 ||
                input.lifetimeSeconds > 120
            ) {
                throw new Error('Invalid browser SSO bootstrap ticket lifetime.');
            }
            const ticket = createBrowserSsoOpaqueValue();
            return backend.run(input.now, async (tx) => {
                const request = await readBootstrapRequest(tx, input);
                if (
                    !request ||
                    request.scope !== input.scope ||
                    request.grantHash !== hashBrowserSsoValue(input.grantId)
                ) {
                    return { kind: 'request_rejected' };
                }
                const binding = await tx.get(key('binding', request.bindingHash));
                if (binding?.kind !== 'binding') {
                    return { kind: 'request_rejected' };
                }
                const record = bootstrapSchema.parse({
                    bootstrapEpoch: binding.bootstrapEpoch ?? 0,
                    kind: 'bootstrap',
                    id: hashBrowserSsoValue(ticket),
                    requestHash: request.id,
                    bindingHash: request.bindingHash,
                    siteId: request.siteId,
                    redirectUri: request.redirectUri,
                    scope: request.scope,
                    state: request.state,
                    email: input.email,
                    accessTokenHash: input.accessTokenHash,
                    createdAt: input.now,
                    expiresAt: Math.min(
                        request.expiresAt,
                        input.now + input.lifetimeSeconds * 1000,
                    ),
                });
                await tx.set(key('binding', request.bindingHash), {
                    ...binding,
                    bootstrapEpoch: binding.bootstrapEpoch ?? 0,
                });
                await tx.set(key('bootstrap', record.id), record);
                await tx.set(key('request', request.id), null);
                return { kind: 'issued', ticket, record };
            });
        },
        async getBootstrapTicket(ticket, now) {
            return backend.run(now, async (tx) => {
                const record = await tx.get(key('bootstrap', hashBrowserSsoValue(ticket)));
                return record?.kind === 'bootstrap' ? record : null;
            });
        },
        async redeemBootstrapTicket(input) {
            requireFutureExpiry(input.now, input.sessionExpiresAt);
            const handle = createBrowserSsoOpaqueValue();
            return backend.run(input.now, async (tx) => {
                const context = await readRedeemableBootstrap(tx, input);
                if (!context) {
                    return { kind: 'ticket_rejected' };
                }
                const { ticketKey, ticket, originalBinding } = context;
                const currentBindingHash = hashBrowserSsoValue(input.browserBinding);
                const currentBinding =
                    currentBindingHash === ticket.bindingHash
                        ? originalBinding
                        : await tx.get(key('binding', currentBindingHash));
                const previous =
                    input.previousHandle === undefined
                        ? null
                        : await readActiveSession(tx, hashBrowserSsoValue(input.previousHandle));
                if (
                    input.confirmedAccountChange !== true &&
                    (ticket.bindingHash !== hashBrowserSsoValue(input.browserBinding) ||
                        (previous?.kind === 'session' && previous.email !== ticket.email))
                ) {
                    return { kind: 'confirmation_required' };
                }
                const activeBinding = currentBinding?.kind === 'binding' ? currentBinding : null;
                const session = sessionSchema.parse({
                    kind: 'session',
                    bootstrapBindingHash: currentBindingHash,
                    bootstrapEpoch: activeBinding?.bootstrapEpoch ?? 0,
                    id: hashBrowserSsoValue(handle),
                    email: ticket.email,
                    createdAt: input.now,
                    expiresAt: input.sessionExpiresAt,
                });
                await tx.set(key('binding', currentBindingHash), {
                    kind: 'binding',
                    requests: activeBinding?.requests ?? [],
                    bootstrapEpoch: activeBinding?.bootstrapEpoch ?? 0,
                    expiresAt: Math.max(currentBinding?.expiresAt ?? 0, session.expiresAt + 30_000),
                });
                await tx.set(ticketKey, null);
                if (input.previousHandle !== undefined) {
                    await tx.set(key('session', hashBrowserSsoValue(input.previousHandle)), null);
                }
                await tx.set(key('session', session.id), session);
                return { kind: 'redeemed', ticket, handle, session };
            });
        },
        async createSession(input) {
            requireFutureExpiry(input.now, input.expiresAt);
            const handle = createBrowserSsoOpaqueValue();
            const session = sessionSchema.parse({
                kind: 'session',
                id: hashBrowserSsoValue(handle),
                email: input.email,
                createdAt: input.now,
                expiresAt: input.expiresAt,
            });
            return backend.run(input.now, async (tx) => {
                if (input.previousHandle !== undefined) {
                    await tx.set(key('session', hashBrowserSsoValue(input.previousHandle)), null);
                }
                await tx.set(key('session', session.id), session);
                return { handle, session };
            });
        },
        async getSession(handle, now) {
            return backend.run(now, async (tx) => {
                return readActiveSession(tx, hashBrowserSsoValue(handle));
            });
        },
        async revokeSession(handle, now) {
            await backend.run(now, async (tx) => {
                await tx.set(key('session', hashBrowserSsoValue(handle)), null);
            });
        },
        async createRequest(input) {
            requireFutureExpiry(input.now, input.expiresAt);
            const requestId = createBrowserSsoOpaqueValue();
            const request = requestSchema.parse({
                kind: 'request',
                ...(input.flow === undefined ? {} : { flow: input.flow }),
                id: hashBrowserSsoValue(requestId),
                bindingHash: hashBrowserSsoValue(input.browserBinding),
                siteId: input.siteId,
                redirectUri: input.redirectUri,
                state: input.state,
                codeChallenge: input.codeChallenge,
                scope: input.scope,
                grantHash: null,
                createdAt: input.now,
                expiresAt: input.expiresAt,
            });
            return backend.run(input.now, async (tx) => {
                const bindingKey = key('binding', request.bindingHash);
                const binding = await tx.get(bindingKey);
                const pending: string[] = [];
                let expiresAt = request.expiresAt;
                if (binding?.kind === 'binding') {
                    expiresAt = Math.max(expiresAt, binding.expiresAt);
                    for (const id of binding.requests) {
                        const previous = await tx.get(key('request', id));
                        if (previous?.kind === 'request') {
                            pending.push(id);
                            expiresAt = Math.max(expiresAt, previous.expiresAt);
                        }
                    }
                }
                if (pending.length >= 32) {
                    return { kind: 'request_limit' };
                }
                const additionalRecords = binding?.kind === 'binding' ? 1 : 2;
                if (
                    tx.hasRequestCapacity !== undefined &&
                    !(await tx.hasRequestCapacity(additionalRecords))
                ) {
                    return { kind: 'request_limit' };
                }
                await tx.set(key('request', request.id), request);
                await tx.set(bindingKey, {
                    kind: 'binding',
                    requests: [...pending, request.id],
                    ...(binding?.kind === 'binding' && binding.bootstrapEpoch !== undefined
                        ? { bootstrapEpoch: binding.bootstrapEpoch }
                        : {}),
                    expiresAt,
                });
                return { kind: 'created', requestId, request };
            });
        },
        async getRequest(requestId, now) {
            return backend.run(now, async (tx) => {
                const record = await tx.get(key('request', hashBrowserSsoValue(requestId)));
                return record?.kind === 'request' ? record : null;
            });
        },
        async bindGrant(input) {
            return backend.run(input.now, async (tx) => {
                const requestKey = key('request', hashBrowserSsoValue(input.requestId));
                const request = await tx.get(requestKey);
                if (
                    request?.kind !== 'request' ||
                    request.bindingHash !== hashBrowserSsoValue(input.browserBinding)
                ) {
                    return false;
                }
                await tx.set(requestKey, {
                    ...request,
                    grantHash: hashBrowserSsoValue(input.grantId),
                });
                return true;
            });
        },
        async issueCode(input) {
            if (
                !Number.isInteger(input.lifetimeSeconds) ||
                input.lifetimeSeconds < 1 ||
                input.lifetimeSeconds > 120
            ) {
                throw new Error('Invalid browser SSO code lifetime.');
            }
            const code = createBrowserSsoOpaqueValue();
            return backend.run(input.now, async (tx) => {
                const requestKey = key('request', hashBrowserSsoValue(input.requestId));
                const request = await tx.get(requestKey);
                const grantHash =
                    input.grantId === undefined ? null : hashBrowserSsoValue(input.grantId);
                if (
                    request?.kind !== 'request' ||
                    request.flow === 'launcher' ||
                    request.grantHash !== grantHash ||
                    request.bindingHash !== hashBrowserSsoValue(input.browserBinding)
                ) {
                    return { kind: 'request_rejected' };
                }
                const session = await readActiveSession(
                    tx,
                    hashBrowserSsoValue(input.sessionHandle),
                );
                if (session?.kind !== 'session') {
                    return { kind: 'session_expired' };
                }
                const record = codeSchema.parse({
                    kind: 'code',
                    id: hashBrowserSsoValue(code),
                    sessionId: session.id,
                    siteId: request.siteId,
                    redirectUri: request.redirectUri,
                    scope: request.scope,
                    codeChallenge: request.codeChallenge,
                    createdAt: input.now,
                    expiresAt: Math.min(
                        input.now + input.lifetimeSeconds * 1000,
                        session.expiresAt,
                    ),
                });
                await tx.set(key('code', record.id), record);
                await tx.set(requestKey, null);
                return { kind: 'issued', code, request };
            });
        },
        async inspectCode(code, now) {
            return backend.run(now, async (tx) => {
                const record = await tx.get(key('code', hashBrowserSsoValue(code)));
                if (record?.kind !== 'code') {
                    return null;
                }
                const session = await readActiveSession(tx, record.sessionId);
                return { code: record, session: session?.kind === 'session' ? session : null };
            });
        },
        async redeemCode(input) {
            return backend.run(input.now, async (tx) => {
                const codeKey = key('code', hashBrowserSsoValue(input.code));
                const code = await tx.get(codeKey);
                const challenge = createHash('sha256')
                    .update(input.codeVerifier, 'ascii')
                    .digest('base64url');
                if (
                    code?.kind !== 'code' ||
                    !/^[A-Za-z0-9._~-]{43,128}$/.test(input.codeVerifier) ||
                    code.codeChallenge !== challenge ||
                    code.redirectUri !== input.redirectUri ||
                    code.siteId !== input.siteId ||
                    code.scope !== input.scope
                ) {
                    return { kind: 'code_rejected' };
                }
                const session = await readActiveSession(tx, code.sessionId);
                if (session?.kind !== 'session') {
                    return { kind: 'session_expired' };
                }
                if (session.email !== input.email) {
                    return { kind: 'code_rejected' };
                }
                await tx.set(codeKey, null);
                return { kind: 'redeemed', session, code };
            });
        },
        async prune(now) {
            await backend.run(now, async () => undefined);
        },
    };
}
