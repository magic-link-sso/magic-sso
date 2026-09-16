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
 * @typedef {{
 *   apply: boolean;
 *   nextVersion: string;
 *   rootDir: string;
 * }} BumpVersionOptions
 */

/**
 * @param {BumpVersionOptions} options
 * @param {string} relativePath
 * @param {(source: string) => string} readVersion
 * @param {(source: string, nextVersion: string) => string} replaceVersion
 * @returns {Promise<VersionChange | null>}
 */
async function bumpManifestVersion(options, relativePath, readVersion, replaceVersion) {
    const source = await readRepositoryFile(options.rootDir, relativePath);
    const previousVersion = readVersion(source);

    if (previousVersion === options.nextVersion) {
        return null;
    }

    if (options.apply) {
        await writeRepositoryFile(
            options.rootDir,
            relativePath,
            replaceVersion(source, options.nextVersion),
        );
    }

    return { file: relativePath, nextVersion: options.nextVersion, previousVersion };
}

/**
 * @param {string} lockSource
 * @param {string} lockFile
 * @param {string} packageName
 * @returns {string}
 */
function readUvLockPackageVersion(lockSource, lockFile, packageName) {
    const packagePattern = new RegExp(
        String.raw`\[\[package\]\]\nname = "${packageName.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&')}"\nversion = "([^"]+)"`,
        'm',
    );
    const packageVersion = packagePattern.exec(lockSource)?.[1];

    if (!packageVersion) {
        throw new Error(`Expected ${lockFile} to contain package "${packageName}".`);
    }

    return packageVersion;
}

/**
 * @param {BumpVersionOptions} options
 * @param {{ lockFile: string; packageNames: readonly string[] }} project
 * @returns {Promise<VersionChange[]>}
 */
async function bumpUvLockVersions(options, { lockFile, packageNames }) {
    const { nextVersion } = options;
    /** @type {VersionChange[]} */
    const changes = [];
    let lockSource = await readRepositoryFile(options.rootDir, lockFile);

    for (const packageName of packageNames) {
        const previousVersion = readUvLockPackageVersion(lockSource, lockFile, packageName);
        if (previousVersion !== nextVersion) {
            lockSource = replaceUvLockPackageVersion(lockSource, packageName, nextVersion);
            changes.push({ file: `${lockFile} (${packageName})`, nextVersion, previousVersion });
        }
    }

    if (options.apply) {
        await writeRepositoryFile(options.rootDir, lockFile, lockSource);
    }

    return changes;
}

/**
 * @param {BumpVersionOptions} options
 * @returns {Promise<VersionChange[]>}
 */
export async function bumpVersion(options) {
    /** @type {Array<VersionChange | null>} */
    const changes = [];

    for (const relativePath of JS_PACKAGE_FILES) {
        changes.push(
            await bumpManifestVersion(options, relativePath, readJsonVersion, replaceJsonVersion),
        );
    }

    for (const project of PYTHON_PROJECTS) {
        changes.push(
            await bumpManifestVersion(
                options,
                project.pyprojectFile,
                readTomlVersion,
                replaceTomlVersion,
            ),
            ...(await bumpUvLockVersions(options, project)),
        );
    }

    return changes.filter((change) => change !== null);
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
