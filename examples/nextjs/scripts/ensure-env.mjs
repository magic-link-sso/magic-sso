// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Wojciech Polak

import { access, copyFile } from 'node:fs/promises';
import { readFile, writeFile } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';

const defaultSourcePath = new URL('../.env.local.example', import.meta.url);
const defaultTargetPath = new URL('../.env.local', import.meta.url);
const generatedPlaceholderValues = new Map([
    ['MAGICSSO_JWT_SECRET', new Set(['replace-me-with-a-long-random-jwt-secret'])],
    ['MAGICSSO_PREVIEW_SECRET', new Set(['replace-me-with-a-long-random-preview-secret'])],
]);

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
        const match = line.match(/^([A-Za-z_][A-Za-z0-9_]*)=/u);
        if (match) {
            keys.add(match[1]);
        }
    }

    return keys;
}

function parseEnvValues(content) {
    const values = new Map();
    for (const line of content.split('\n')) {
        const match = line.match(/^([A-Za-z_][A-Za-z0-9_]*)=(.*)$/u);
        if (match) {
            values.set(match[1], match[2]);
        }
    }

    return values;
}

function mergeEnvContent(sourceContent, targetContent) {
    const sourceValues = parseEnvValues(sourceContent);
    const targetKeys = parseEnvKeys(targetContent);
    let changed = false;
    const targetLines = targetContent.split('\n').map((line) => {
        const match = line.match(/^([A-Za-z_][A-Za-z0-9_]*)=(.*)$/u);
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

export async function ensureEnvFile(
    sourcePath = defaultSourcePath,
    targetPath = defaultTargetPath,
) {
    if (await fileExists(targetPath)) {
        const [sourceContent, targetContent] = await Promise.all([
            readFile(sourcePath, 'utf8'),
            readFile(targetPath, 'utf8'),
        ]);
        const mergedContent = mergeEnvContent(sourceContent, targetContent);
        if (mergedContent === targetContent) {
            return;
        }

        await writeFile(targetPath, mergedContent, 'utf8');
        return;
    }

    await copyFile(sourcePath, targetPath);
}

const executedPath = process.argv[1];
if (typeof executedPath === 'string' && pathToFileURL(executedPath).href === import.meta.url) {
    await ensureEnvFile();
}
