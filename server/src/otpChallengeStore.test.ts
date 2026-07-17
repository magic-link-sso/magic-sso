import { existsSync, mkdtempSync, rmSync, statSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { hashOtpCode } from './otp.js';
import {
    createFileOtpChallengeStore,
    createInMemoryOtpChallengeStore,
    parseOtpChallenge,
    type OtpChallenge,
    type OtpChallengeStore,
} from './otpChallengeStore.js';

function createChallenge(overrides: Partial<OtpChallenge> = {}): OtpChallenge {
    const challengeId = overrides.challengeId ?? 'challenge-1';
    const jti = overrides.jti ?? 'grant-1';
    const siteId = overrides.siteId ?? 'site-1';
    return {
        attemptsRemaining: 3,
        challengeId,
        createdAt: Date.now(),
        email: 'user@example.com',
        expiresAt: Date.now() + 60_000,
        jti,
        otpHash: hashOtpCode({
            challengeId,
            code: '012345',
            jti,
            secret: 'otp-secret',
            siteId,
        }),
        rotationKey: 'rotation-1',
        safeReturnUrl: 'http://client.example.com/',
        safeVerifyUrl: 'http://client.example.com/verify-email',
        scope: '*',
        siteId,
        ...overrides,
    };
}

function fileMode(path: string): number {
    return statSync(path).mode & 0o777;
}

describe('file OTP challenge store', () => {
    let directory: string;

    beforeEach(() => {
        directory = mkdtempSync(join(tmpdir(), 'magic-sso-otp-'));
    });

    afterEach(() => {
        rmSync(directory, { recursive: true, force: true });
    });

    it('stores only the code hash with private filesystem permissions', async () => {
        const store = await createFileOtpChallengeStore({ directory });
        await store.create(createChallenge());

        expect(fileMode(directory)).toBe(0o700);
        expect(fileMode(join(directory, 'challenge-1.json'))).toBe(0o600);
    });

    it('counts wrong attempts and allows a later correct submission', async () => {
        const store = await createFileOtpChallengeStore({ directory });
        const challenge = createChallenge();
        await store.create(challenge);

        await expect(
            store.verify({
                challengeId: challenge.challengeId,
                code: '999999',
                now: Date.now(),
                secret: 'otp-secret',
            }),
        ).resolves.toEqual({ category: 'invalid' });
        await expect(
            store.verify({
                challengeId: challenge.challengeId,
                code: '012345',
                now: Date.now(),
                secret: 'otp-secret',
            }),
        ).resolves.toMatchObject({
            category: 'valid',
            challenge: { ...challenge, attemptsRemaining: 2 },
        });
    });

    it('invalidates a challenge after its final wrong attempt', async () => {
        const store = await createFileOtpChallengeStore({ directory });
        const challenge = createChallenge({ attemptsRemaining: 1 });
        await store.create(challenge);

        await expect(
            store.verify({
                challengeId: challenge.challengeId,
                code: '999999',
                now: Date.now(),
                secret: 'otp-secret',
            }),
        ).resolves.toEqual({ category: 'too_many_attempts' });
        await expect(
            store.verify({
                challengeId: challenge.challengeId,
                code: '012345',
                now: Date.now(),
                secret: 'otp-secret',
            }),
        ).resolves.toEqual({ category: 'not_found' });
    });

    it('removes expired and exhausted challenges', async () => {
        const store = await createFileOtpChallengeStore({ directory });
        const expiredChallenge = createChallenge({
            expiresAt: Date.now() - 1,
        });
        const exhaustedChallenge = createChallenge({
            attemptsRemaining: 0,
            challengeId: 'challenge-2',
            jti: 'grant-2',
            rotationKey: 'rotation-2',
        });
        await store.create(expiredChallenge);
        await store.create(exhaustedChallenge);

        await expect(
            store.verify({
                challengeId: expiredChallenge.challengeId,
                code: '012345',
                now: Date.now(),
                secret: 'otp-secret',
            }),
        ).resolves.toEqual({ category: 'expired' });
        await expect(
            store.verify({
                challengeId: exhaustedChallenge.challengeId,
                code: '012345',
                now: Date.now(),
                secret: 'otp-secret',
            }),
        ).resolves.toEqual({ category: 'too_many_attempts' });
    });

    it('rejects a challenge when its active rotation pointer has changed', async () => {
        const store = await createFileOtpChallengeStore({ directory });
        const challenge = createChallenge();
        await store.create(challenge);
        writeFileSync(join(directory, 'rotation-1.active'), 'other-challenge');

        await expect(
            store.verify({
                challengeId: challenge.challengeId,
                code: '012345',
                now: Date.now(),
                secret: 'otp-secret',
            }),
        ).resolves.toEqual({ category: 'consumed' });
        expect(existsSync(join(directory, 'challenge-1.json'))).toBe(false);
    });

    it('prunes invalid challenge records and stale rotation locks before creating a challenge', async () => {
        writeFileSync(join(directory, 'invalid.json'), '{}');
        const staleLockPath = join(directory, 'rotation%3Arotation-1.lock');
        writeFileSync(staleLockPath, '');
        const staleTime = new Date(Date.now() - 20_000);
        utimesSync(staleLockPath, staleTime, staleTime);

        const store = await createFileOtpChallengeStore({ directory });
        await store.create(createChallenge());

        expect(existsSync(join(directory, 'invalid.json'))).toBe(false);
        expect(existsSync(staleLockPath)).toBe(false);
    });

    it('allows only one simultaneous correct verification', async () => {
        const store = await createFileOtpChallengeStore({ directory });
        const challenge = createChallenge();
        await store.create(challenge);

        const results = await Promise.all(
            Array.from({ length: 8 }, () =>
                store.verify({
                    challengeId: challenge.challengeId,
                    code: '012345',
                    now: Date.now(),
                    secret: 'otp-secret',
                }),
            ),
        );
        expect(results.filter((result) => result.category === 'valid')).toHaveLength(1);
    });

    it('invalidates the previous challenge when the same login transaction resends', async () => {
        const store = await createFileOtpChallengeStore({ directory });
        const firstChallenge = createChallenge();
        const secondChallenge = createChallenge({
            challengeId: 'challenge-2',
            jti: 'grant-2',
        });
        await store.create(firstChallenge);
        await store.create(secondChallenge);

        await expect(
            store.verify({
                challengeId: firstChallenge.challengeId,
                code: '012345',
                now: Date.now(),
                secret: 'otp-secret',
            }),
        ).resolves.not.toMatchObject({ category: 'valid' });
        await expect(
            store.verify({
                challengeId: secondChallenge.challengeId,
                code: '012345',
                now: Date.now(),
                secret: 'otp-secret',
            }),
        ).resolves.toMatchObject({ category: 'valid' });
    });
});

async function expectRotation(store: OtpChallengeStore): Promise<void> {
    const firstChallenge = createChallenge();
    const secondChallenge = createChallenge({
        challengeId: 'challenge-2',
        jti: 'grant-2',
    });
    await store.create(firstChallenge);
    await store.create(secondChallenge);

    await expect(
        store.verify({
            challengeId: firstChallenge.challengeId,
            code: '012345',
            now: Date.now(),
            secret: 'otp-secret',
        }),
    ).resolves.not.toMatchObject({ category: 'valid' });
    await expect(
        store.verify({
            challengeId: secondChallenge.challengeId,
            code: '012345',
            now: Date.now(),
            secret: 'otp-secret',
        }),
    ).resolves.toMatchObject({ category: 'valid' });
}

describe('in-memory OTP challenge store', () => {
    it('rotates challenges for the same login transaction', async () => {
        await expectRotation(createInMemoryOtpChallengeStore());
    });

    it('rejects duplicate ids and removes expired or exhausted challenges', async () => {
        const store = createInMemoryOtpChallengeStore();
        const duplicateChallenge = createChallenge();
        const expiredChallenge = createChallenge({
            challengeId: 'challenge-2',
            expiresAt: Date.now() - 1,
            jti: 'grant-2',
            rotationKey: 'rotation-2',
        });
        const exhaustedChallenge = createChallenge({
            attemptsRemaining: 1,
            challengeId: 'challenge-3',
            jti: 'grant-3',
            rotationKey: 'rotation-3',
        });
        await store.create(duplicateChallenge);
        await expect(store.create(duplicateChallenge)).rejects.toThrow(
            'OTP challenge already exists.',
        );
        await store.create(expiredChallenge);
        await store.create(exhaustedChallenge);

        await expect(
            store.verify({
                challengeId: expiredChallenge.challengeId,
                code: '012345',
                now: Date.now(),
                secret: 'otp-secret',
            }),
        ).resolves.toEqual({ category: 'expired' });
        await expect(
            store.verify({
                challengeId: exhaustedChallenge.challengeId,
                code: '999999',
                now: Date.now(),
                secret: 'otp-secret',
            }),
        ).resolves.toEqual({ category: 'too_many_attempts' });
    });
});

describe('OTP challenge parsing', () => {
    it('accepts complete persisted challenges and rejects malformed data', () => {
        const challenge = createChallenge();

        expect(parseOtpChallenge(challenge)).toEqual(challenge);
        expect(parseOtpChallenge({ ...challenge, otpHash: 123 })).toBeNull();
        expect(parseOtpChallenge(null)).toBeNull();
    });
});
