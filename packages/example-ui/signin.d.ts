// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Wojciech Polak

export declare function readMessage(value: unknown): string | null;
export declare function buildFailureResult(
    payload: unknown,
    fallback?: string,
): { message: string };
export declare function readServerUrlConfigError(
    serverUrl: string,
    requestOrigin: string,
    appName: string,
): string | null;
