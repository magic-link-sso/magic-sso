// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Wojciech Polak

import { useRequestEvent, useRuntimeConfig } from 'nuxt/app';
import type { AuthPayload, MagicSsoResolvedConfig } from '../../server/utils/auth';
import { getMagicSsoConfig, verifyRequestAuth } from '../../server/utils/auth';

function asRecord(value: unknown): Record<string, unknown> {
    // Safe after confirming a non-null object before merging runtime config sources.
    return typeof value === 'object' && value !== null ? (value as Record<string, unknown>) : {};
}

export function useMagicSsoConfig(): MagicSsoResolvedConfig {
    const runtimeConfig = useRuntimeConfig();

    if (import.meta.client) {
        return getMagicSsoConfig(runtimeConfig.public.magicSso);
    }

    return getMagicSsoConfig({
        ...asRecord(runtimeConfig.public.magicSso),
        ...asRecord(runtimeConfig.magicSso),
    });
}

export async function useMagicSsoAuth(): Promise<AuthPayload | null> {
    if (import.meta.client) {
        return null;
    }

    const event = useRequestEvent();
    if (!event) {
        return null;
    }

    return verifyRequestAuth(event);
}
