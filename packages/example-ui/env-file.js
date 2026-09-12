// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Wojciech Polak

import { access, copyFile, readFile, writeFile } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';

/**
 * Bootstrap helper shared by the example apps' `scripts/ensure-env.mjs`. Each
 * app owns its own file names and placeholder values; the merge rules live here.
 */

const ENV_ASSIGNMENT = /^([A-Za-z_][A-Za-z0-9_]*)=(.*)$/u;

async function fileExists(path) {
    try {
        await access(path);
        return true;
    } catch {
        return false;
    }
}

function parseEnvKeys(content) {
    const keys = new Set();
    for (const line of content.split('\n')) {
        const match = line.match(ENV_ASSIGNMENT);
        if (match) {
            keys.add(match[1]);
        }
    }

    return keys;
}

function parseEnvValues(content) {
    const values = new Map();
    for (const line of content.split('\n')) {
        const match = line.match(ENV_ASSIGNMENT);
        if (match) {
            values.set(match[1], match[2]);
        }
    }

    return values;
}

/**
 * Merge the example env file into an existing one: refresh values still left at
 * a known placeholder and append any keys the target is missing.
 *
 * @param {string} sourceContent Contents of the committed example env file.
 * @param {string} targetContent Contents of the developer's env file.
 * @param {ReadonlyMap<string, ReadonlySet<string>>} generatedPlaceholderValues
 *   Placeholder values, per key, that may be replaced from the example file.
 * @returns {string} The merged contents, or `targetContent` when unchanged.
 */
export function mergeEnvContent(sourceContent, targetContent, generatedPlaceholderValues) {
    const sourceValues = parseEnvValues(sourceContent);
    const targetKeys = parseEnvKeys(targetContent);
    let changed = false;
    const targetLines = targetContent.split('\n').map((line) => {
        const match = line.match(ENV_ASSIGNMENT);
        if (!match) {
            return line;
        }

        const [, key, value] = match;
        const placeholderValues = generatedPlaceholderValues.get(key);
        const sourceValue = sourceValues.get(key);
        if (
            placeholderValues !== undefined &&
            sourceValue !== undefined &&
            placeholderValues.has(value) &&
            sourceValue !== value
        ) {
            changed = true;
            return `${key}=${sourceValue}`;
        }

        return line;
    });
    const missingLines = sourceContent.split('\n').filter((line) => {
        const match = line.match(/^([A-Za-z_][A-Za-z0-9_]*)=/u);
        return match ? !targetKeys.has(match[1]) : false;
    });

    if (missingLines.length > 0) {
        changed = true;
    }

    return changed
        ? `${targetLines.join('\n').replace(/\n?$/u, '\n')}${missingLines.join('\n')}${
              missingLines.length > 0 ? '\n' : ''
          }`
        : targetContent;
}

/**
 * Create the app's env file from its example, or merge new keys and refreshed
 * placeholder values into an existing one.
 *
 * @param {string | URL} sourcePath Committed example env file.
 * @param {string | URL} targetPath Developer env file to create or update.
 * @param {ReadonlyMap<string, ReadonlySet<string>>} generatedPlaceholderValues
 * @returns {Promise<void>}
 */
export async function ensureEnvFile(sourcePath, targetPath, generatedPlaceholderValues) {
    if (!(await fileExists(targetPath))) {
        await copyFile(sourcePath, targetPath);
        return;
    }

    const [sourceContent, targetContent] = await Promise.all([
        readFile(sourcePath, 'utf8'),
        readFile(targetPath, 'utf8'),
    ]);
    const mergedContent = mergeEnvContent(sourceContent, targetContent, generatedPlaceholderValues);
    if (mergedContent === targetContent) {
        return;
    }

    await writeFile(targetPath, mergedContent, 'utf8');
}

/**
 * Wire up one example app's env bootstrap: bind its example/env file names and
 * placeholder values, and run the bootstrap immediately when the module was
 * invoked as a script rather than imported by a test.
 *
 * @param {{
 *   envPath: string,
 *   examplePath: string,
 *   generatedPlaceholderValues: ReadonlyMap<string, ReadonlySet<string>>,
 *   moduleUrl: string,
 * }} options Paths are resolved relative to `moduleUrl`.
 * @returns {Promise<(sourcePath?: string | URL, targetPath?: string | URL) => Promise<void>>}
 */
export async function bootstrapExampleEnvFile(options) {
    const defaultSourcePath = new URL(options.examplePath, options.moduleUrl);
    const defaultTargetPath = new URL(options.envPath, options.moduleUrl);
    const ensure = async (sourcePath = defaultSourcePath, targetPath = defaultTargetPath) => {
        await ensureEnvFile(sourcePath, targetPath, options.generatedPlaceholderValues);
    };

    const executedPath = process.argv[1];
    if (
        typeof executedPath === 'string' &&
        pathToFileURL(executedPath).href === options.moduleUrl
    ) {
        await ensure();
    }

    return ensure;
}
