// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Wojciech Polak

import { readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import {
    JS_PACKAGE_FILES,
    PYTHON_PROJECTS,
    VERSION_BUMP_PATTERN,
    readJsonVersion,
    readTomlVersion,
    resolveReleaseVersion,
    stripCliSeparators,
} from './release-metadata.mjs';

/**
 * @typedef {{
 *   file: string;
 *   nextVersion: string;
 *   previousVersion: string;
 * }} VersionChange
 */

/**
 * @param {string[]} argv
 * @returns {{ apply: boolean; versionSpecifier: string }}
 */
export function parseCliArgs(argv) {
    const normalizedArgv = stripCliSeparators(argv);
    const positionals = normalizedArgv.filter((argument) => !argument.startsWith('--'));
    const versionSpecifier = positionals[0];

    if (!versionSpecifier) {
        throw new Error(
            'Usage: node scripts/bump-version.mjs <version|major|minor|patch> [--apply]',
        );
    }

    if (
        !VERSION_BUMP_PATTERN.test(versionSpecifier) &&
        !/^\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?$/u.test(versionSpecifier)
    ) {
        throw new Error(`Unsupported version "${versionSpecifier}".`);
    }

    return {
        apply: normalizedArgv.includes('--apply'),
        versionSpecifier,
    };
}

/**
 * @param {string} source
 * @param {string} nextVersion
 * @returns {string}
 */
export function replaceJsonVersion(source, nextVersion) {
    const parsed = JSON.parse(source);
    readJsonVersion(source);

    parsed.version = nextVersion;
    return `${JSON.stringify(parsed, null, 4)}\n`;
}

/**
 * @param {string} source
 * @param {string} nextVersion
 * @returns {string}
 */
export function replaceTomlVersion(source, nextVersion) {
    readTomlVersion(source);

    return source.replace(/^version = ".*"$/m, `version = "${nextVersion}"`);
}

/**
 * @param {string} source
 * @param {string} packageName
 * @param {string} nextVersion
 * @returns {string}
 */
export function replaceUvLockPackageVersion(source, packageName, nextVersion) {
    const escapedPackageName = packageName.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&');
    const pattern = new RegExp(
        String.raw`(\[\[package\]\]\nname = "${escapedPackageName}"\nversion = ")([^"]+)(")`,
        'm',
    );

    if (!pattern.test(source)) {
        throw new Error(`Could not find package "${packageName}" in uv.lock.`);
    }

    return source.replace(pattern, `$1${nextVersion}$3`);
}

/**
 * @param {string} rootDir
 * @param {string} relativePath
 * @returns {Promise<string>}
 */
async function readRepositoryFile(rootDir, relativePath) {
    return readFile(path.join(rootDir, relativePath), 'utf8');
}

/**
 * @param {string} rootDir
 * @param {string} relativePath
 * @param {string} contents
 * @returns {Promise<void>}
 */
async function writeRepositoryFile(rootDir, relativePath, contents) {
    await writeFile(path.join(rootDir, relativePath), contents, 'utf8');
}

/**
 * @param {{
 *   apply: boolean;
 *   nextVersion: string;
 *   rootDir: string;
 * }} options
 * @returns {Promise<VersionChange[]>}
 */
export async function bumpVersion(options) {
    const { apply, nextVersion, rootDir } = options;
    /** @type {VersionChange[]} */
    const changes = [];

    for (const relativePath of JS_PACKAGE_FILES) {
        const source = await readRepositoryFile(rootDir, relativePath);
        const previousVersion = readJsonVersion(source);

        if (previousVersion === nextVersion) {
            continue;
        }

        const nextSource = replaceJsonVersion(source, nextVersion);

        if (apply) {
            await writeRepositoryFile(rootDir, relativePath, nextSource);
        }

        changes.push({
            file: relativePath,
            nextVersion,
            previousVersion,
        });
    }

    for (const { lockFile, packageNames, pyprojectFile } of PYTHON_PROJECTS) {
        const pyprojectSource = await readRepositoryFile(rootDir, pyprojectFile);
        const previousPyprojectVersion = readTomlVersion(pyprojectSource);

        if (previousPyprojectVersion !== nextVersion) {
            const nextPyprojectSource = replaceTomlVersion(pyprojectSource, nextVersion);

            if (apply) {
                await writeRepositoryFile(rootDir, pyprojectFile, nextPyprojectSource);
            }

            changes.push({
                file: pyprojectFile,
                nextVersion,
                previousVersion: previousPyprojectVersion,
            });
        }

        let lockSource = await readRepositoryFile(rootDir, lockFile);

        for (const packageName of packageNames) {
            const packagePattern = new RegExp(
                String.raw`\[\[package\]\]\nname = "${packageName.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&')}"\nversion = "([^"]+)"`,
                'm',
            );
            const packageMatch = packagePattern.exec(lockSource);

            if (!packageMatch?.[1]) {
                throw new Error(`Expected ${lockFile} to contain package "${packageName}".`);
            }

            if (packageMatch[1] === nextVersion) {
                continue;
            }

            lockSource = replaceUvLockPackageVersion(lockSource, packageName, nextVersion);
            changes.push({
                file: `${lockFile} (${packageName})`,
                nextVersion,
                previousVersion: packageMatch[1],
            });
        }

        if (apply) {
            await writeRepositoryFile(rootDir, lockFile, lockSource);
        }
    }

    return changes;
}

/**
 * @param {VersionChange[]} changes
 * @returns {string}
 */
export function formatVersionChanges(changes) {
    if (changes.length === 0) {
        return 'No version fields needed updating.';
    }

    return changes
        .map((change) => `${change.file}: ${change.previousVersion} -> ${change.nextVersion}`)
        .join('\n');
}

/**
 * @returns {Promise<void>}
 */
export async function main() {
    const { apply, versionSpecifier } = parseCliArgs(process.argv.slice(2));
    const rootDir = process.cwd();
    const nextVersion = await resolveReleaseVersion(rootDir, versionSpecifier);
    const changes = await bumpVersion({
        apply,
        nextVersion,
        rootDir,
    });

    console.log(formatVersionChanges(changes));
}

if (import.meta.url === `file://${process.argv[1]}`) {
    await main();
}
