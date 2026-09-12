// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Wojciech Polak

export declare function mergeEnvContent(
    sourceContent: string,
    targetContent: string,
    generatedPlaceholderValues: ReadonlyMap<string, ReadonlySet<string>>,
): string;
export declare function ensureEnvFile(
    sourcePath: string | URL,
    targetPath: string | URL,
    generatedPlaceholderValues: ReadonlyMap<string, ReadonlySet<string>>,
): Promise<void>;

export declare function bootstrapExampleEnvFile(options: {
    envPath: string;
    examplePath: string;
    generatedPlaceholderValues: ReadonlyMap<string, ReadonlySet<string>>;
    moduleUrl: string;
}): Promise<(sourcePath?: string | URL, targetPath?: string | URL) => Promise<void>>;
