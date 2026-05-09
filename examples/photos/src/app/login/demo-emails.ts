// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Wojciech Polak

const fallbackDemoEmails = ['owner@example.com', 'friend@example.com', 'family@example.com'];

type DemoEmailEnv = Partial<
    Pick<NodeJS.ProcessEnv, 'PHOTOS_OWNER_EMAIL' | 'PHOTOS_FRIEND_EMAIL' | 'PHOTOS_FAMILY_EMAIL'>
>;

function readCurrentDemoEmailEnv(): DemoEmailEnv {
    return {
        PHOTOS_FAMILY_EMAIL: process.env.PHOTOS_FAMILY_EMAIL,
        PHOTOS_FRIEND_EMAIL: process.env.PHOTOS_FRIEND_EMAIL,
        PHOTOS_OWNER_EMAIL: process.env.PHOTOS_OWNER_EMAIL,
    };
}

export function getDemoEmailsFromEnv(
    env: DemoEmailEnv = readCurrentDemoEmailEnv(),
): readonly string[] {
    const configuredEmails = [
        env.PHOTOS_OWNER_EMAIL,
        env.PHOTOS_FRIEND_EMAIL,
        env.PHOTOS_FAMILY_EMAIL,
    ].filter((value): value is string => typeof value === 'string' && value.length > 0);

    return configuredEmails.length > 0 ? [...new Set(configuredEmails)] : fallbackDemoEmails;
}

export function getDemoScopeForEmail(
    email: string,
    env: DemoEmailEnv = readCurrentDemoEmailEnv(),
): string | undefined {
    const normalizedEmail = email.trim().toLowerCase();
    if (normalizedEmail.length === 0) {
        return undefined;
    }

    const friendEmail = env.PHOTOS_FRIEND_EMAIL?.trim().toLowerCase() ?? 'friend@example.com';
    const familyEmail = env.PHOTOS_FAMILY_EMAIL?.trim().toLowerCase() ?? 'family@example.com';

    if (normalizedEmail === friendEmail) {
        return 'friends';
    }
    if (normalizedEmail === familyEmail) {
        return 'family';
    }

    return undefined;
}
