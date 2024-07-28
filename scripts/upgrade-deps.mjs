// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Wojciech Polak

import { execFile } from 'node:child_process';
import { access, readFile, readdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);
const UV_ENV = {
    ...process.env,
    UV_CACHE_DIR: '/tmp/uv-cache',
    UV_TOOL_DIR: '/tmp/uv-tools',
    UV_STATE_DIR: '/tmp/uv-state',
};

/**
 * @typedef {{
 *   apply: boolean;
 *   includePeer: boolean;
 *   includePythonPackage: boolean;
 *   mode: 'compatible' | 'latest';
 * }} CliOptions
 */

/**
 * @typedef {{
 *   dependency: string;
 *   next: string;
 *   previous: string;
 * }} DependencyChange
 */

/**
 * @typedef {{
 *   changes: DependencyChange[];
 *   nextSource: string;
 * }} PythonPlan
 */

/**
 * @typedef {{
 *   dependencies?: Record<string, string>;
 *   devDependencies?: Record<string, string>;
 *   peerDependencies?: Record<string, string>;
 * }} PackageManifest
 */

/**
 * @param {string[]} argv
 * @returns {CliOptions}
 */
export function parseCliArgs(argv) {
    if (argv.includes('--help') || argv.includes('-h')) {
        console.log(
            [
                'Usage: node scripts/upgrade-deps.mjs <compatible|latest> [--apply] [--include-peer] [--include-python-package]',
                '',
                'Examples:',
                '  pnpm deps:upgrade',
                '  pnpm deps:upgrade -- --apply',
                '  pnpm deps:upgrade:latest',
                '  pnpm deps:upgrade:latest -- --include-peer --apply',
            ].join('\n'),
        );
        process.exit(0);
    }

    const positionals = argv.filter((argument) => !argument.startsWith('--'));
    const rawMode = positionals[0] ?? 'compatible';

    if (rawMode !== 'compatible' && rawMode !== 'latest') {
        throw new Error(`Unknown mode "${rawMode}". Expected "compatible" or "latest".`);
    }

    return {
        apply: argv.includes('--apply'),
        includePeer: argv.includes('--include-peer'),
        includePythonPackage: argv.includes('--include-python-package'),
        mode: rawMode,
    };
}

/**
 * @param {string} rootDir
 * @returns {Promise<string[]>}
 */
export async function findJsPackageFiles(rootDir) {
    const files = [path.join(rootDir, 'package.json')];
    const packageDirs = [path.join(rootDir, 'packages'), path.join(rootDir, 'examples')];

    for (const parentDir of packageDirs) {
        const entries = await readdir(parentDir, { withFileTypes: true });

        for (const entry of entries) {
            if (!entry.isDirectory()) {
                continue;
            }

            const packageFile = path.join(parentDir, entry.name, 'package.json');

            try {
                await access(packageFile);
                files.push(packageFile);
            } catch {
                // The directory is not a JS package.
            }
        }
    }

    files.push(path.join(rootDir, 'server', 'package.json'));
    files.push(path.join(rootDir, 'tests', 'e2e', 'package.json'));

    return files;
}

/**
 * @param {PackageManifest} manifest
 * @param {boolean} includePeer
 * @returns {string[]}
 */
export function collectJsRejectNames(manifest, includePeer) {
    /** @type {Set<string>} */
    const reject = new Set();
    const sections = includePeer
        ? ['dependencies', 'devDependencies', 'peerDependencies']
        : ['dependencies', 'devDependencies', 'peerDependencies'];

    for (const section of sections) {
        const dependencies = manifest[section];

        if (!dependencies) {
            continue;
        }

        for (const [name, specifier] of Object.entries(dependencies)) {
            if (!includePeer && section === 'peerDependencies') {
                reject.add(name);
                continue;
            }

            if (specifier === 'latest' || specifier.startsWith('workspace:')) {
                reject.add(name);
            }
        }
    }

    return [...reject];
}

/**
 * @param {PackageManifest} manifest
 * @param {Record<string, string>} proposed
 * @param {boolean} includePeer
 * @returns {DependencyChange[]}
 */
export function buildJsChanges(manifest, proposed, includePeer) {
    const changes = [];
    const sections = includePeer
        ? ['dependencies', 'devDependencies', 'peerDependencies']
        : ['dependencies', 'devDependencies'];

    for (const [dependency, next] of Object.entries(proposed)) {
        for (const section of sections) {
            const previous = manifest[section]?.[dependency];

            if (!previous || previous === next) {
                continue;
            }

            changes.push({ dependency, next, previous });
            break;
        }
    }

    return changes.sort((left, right) => left.dependency.localeCompare(right.dependency));
}

/**
 * @param {string} source
 * @returns {Record<string, string>}
 */
export function parseUvLockVersions(source) {
    /** @type {Record<string, string>} */
    const versions = {};
    const packagePattern = /\[\[package\]\]\s+name = "([^"]+)"\s+version = "([^"]+)"/gmu;

    for (const match of source.matchAll(packagePattern)) {
        const [, name, version] = match;

        if (name && version) {
            versions[name] = version;
        }
    }

    return versions;
}

/**
 * @param {string} source
 * @param {string} arrayName
 * @returns {{ items: string[]; match: RegExpExecArray }}
 */
export function parseTomlArrayLine(source, arrayName) {
    const pattern = new RegExp(`^${arrayName} = \\[(.*)\\]$`, 'mu');
    const match = pattern.exec(source);

    if (!match) {
        throw new Error(`Could not find TOML array "${arrayName}".`);
    }

    const body = match[1] ?? '';
    const items = [...body.matchAll(/"([^"]+)"/gmu)].map((item) => item[1] ?? '');

    return { items, match };
}

/**
 * @param {string} requirement
 * @returns {{ name: string; specifier: string }}
 */
export function parsePythonRequirement(requirement) {
    const match = /^([A-Za-z0-9._-]+)\s*(.*)$/u.exec(requirement.trim());

    if (!match) {
        throw new Error(`Unsupported Python requirement "${requirement}".`);
    }

    return {
        name: match[1],
        specifier: match[2] ?? '',
    };
}

/**
 * @param {string} source
 * @returns {Set<string>}
 */
export function parseLocalPythonSources(source) {
    const sectionPattern = /^\[tool\.uv\.sources\]$(?<body>[\s\S]*)/mu;
    const section = sectionPattern.exec(source)?.groups?.body ?? '';
    /** @type {Set<string>} */
    const localPackages = new Set();

    for (const match of section.matchAll(/^([A-Za-z0-9._-]+)\s*=\s*\{[^}]*path\s*=/gmu)) {
        const packageName = match[1];

        if (packageName) {
            localPackages.add(packageName);
        }
    }

    return localPackages;
}

/**
 * @param {string} version
 * @returns {number[]}
 */
export function parseVersionParts(version) {
    return version
        .split(/[^0-9]+/u)
        .filter(Boolean)
        .map((part) => Number.parseInt(part, 10));
}

/**
 * @param {string} left
 * @param {string} right
 * @returns {number}
 */
export function compareVersions(left, right) {
    const leftParts = parseVersionParts(left);
    const rightParts = parseVersionParts(right);
    const length = Math.max(leftParts.length, rightParts.length);

    for (let index = 0; index < length; index += 1) {
        const leftPart = leftParts[index] ?? 0;
        const rightPart = rightParts[index] ?? 0;

        if (leftPart !== rightPart) {
            return leftPart - rightPart;
        }
    }

    return left.localeCompare(right);
}

/**
 * @param {string[]} versions
 * @returns {string[]}
 */
export function filterStablePythonVersions(versions) {
    return versions.filter((version) => !/[A-Za-z]/u.test(version));
}

/**
 * @param {string[]} versions
 * @param {number} major
 * @returns {string | null}
 */
export function selectLatestVersionInMajor(versions, major) {
    const matches = filterStablePythonVersions(versions).filter((version) => {
        const [versionMajor] = parseVersionParts(version);
        return versionMajor === major;
    });

    if (matches.length === 0) {
        return null;
    }

    return matches.sort(compareVersions).at(-1) ?? null;
}

/**
 * @param {string} version
 * @returns {string}
 */
export function buildBoundedRequirement(version) {
    const [major] = parseVersionParts(version);

    if (!Number.isInteger(major)) {
        throw new Error(`Could not determine major version for "${version}".`);
    }

    return `>=${version},<${major + 1}`;
}

/**
 * @param {{
 *   currentRequirement: string;
 *   latestVersion: string;
 *   lockedVersion: string | undefined;
 *   localSources: Set<string>;
 *   mode: 'compatible' | 'latest';
 *   packageVersions: string[];
 * }} options
 * @returns {string | null}
 */
export function selectPythonRequirementUpdate(options) {
    const {
        currentRequirement,
        latestVersion,
        localSources,
        lockedVersion,
        mode,
        packageVersions,
    } = options;
    const parsed = parsePythonRequirement(currentRequirement);

    if (localSources.has(parsed.name)) {
        return null;
    }

    let targetVersion = latestVersion;

    if (mode === 'compatible') {
        const referenceVersion = lockedVersion ?? latestVersion;
        const [major] = parseVersionParts(referenceVersion);
        const latestCompatible = selectLatestVersionInMajor(packageVersions, major);

        if (!latestCompatible) {
            throw new Error(
                `Could not find a compatible release for "${parsed.name}" in major ${String(major)}.`,
            );
        }

        targetVersion = latestCompatible;
    }

    const nextSpecifier = buildBoundedRequirement(targetVersion);
    const nextRequirement = `${parsed.name}${nextSpecifier}`;

    return nextRequirement === currentRequirement ? null : nextRequirement;
}

/**
 * @param {string} source
 * @param {RegExpExecArray} match
 * @param {string[]} items
 * @returns {string}
 */
export function replaceTomlArrayLine(source, match, items) {
    const start = match.index ?? 0;
    const end = start + match[0].length;
    const replacement = `${match[0].slice(0, match[0].indexOf('[') + 1)}${items
        .map((item) => `"${item}"`)
        .join(', ')}]`;

    return `${source.slice(0, start)}${replacement}${source.slice(end)}`;
}

/**
 * @param {{
 *   lockSource: string;
 *   mode: 'compatible' | 'latest';
 *   packageMetadata: Record<string, { versions: string[] }>;
 *   source: string;
 * }} options
 * @returns {PythonPlan}
 */
export function planPythonManifestUpdate(options) {
    const { lockSource, mode, packageMetadata, source } = options;
    const lockVersions = parseUvLockVersions(lockSource);
    const localSources = parseLocalPythonSources(source);
    const dependencyArray = parseTomlArrayLine(source, 'dependencies');
    const devArray = parseTomlArrayLine(source, 'dev');
    const nextDependencies = [...dependencyArray.items];
    const nextDevDependencies = [...devArray.items];
    /** @type {DependencyChange[]} */
    const changes = [];

    const applyUpdates = (items, targetItems) => {
        items.forEach((item, index) => {
            const { name } = parsePythonRequirement(item);

            if (localSources.has(name)) {
                return;
            }

            const metadata = packageMetadata[name];

            if (!metadata) {
                throw new Error(`Missing package metadata for Python dependency "${name}".`);
            }

            const stableVersions = filterStablePythonVersions(metadata.versions);
            const latestVersion = stableVersions.sort(compareVersions).at(-1);

            if (!latestVersion) {
                throw new Error(`No stable versions were found for Python dependency "${name}".`);
            }

            const nextRequirement = selectPythonRequirementUpdate({
                currentRequirement: item,
                latestVersion,
                localSources,
                lockedVersion: lockVersions[name],
                mode,
                packageVersions: metadata.versions,
            });

            if (!nextRequirement) {
                return;
            }

            targetItems[index] = nextRequirement;
            changes.push({
                dependency: name,
                next: nextRequirement,
                previous: item,
            });
        });
    };

    applyUpdates(dependencyArray.items, nextDependencies);
    applyUpdates(devArray.items, nextDevDependencies);

    let nextSource = source;
    nextSource = replaceTomlArrayLine(nextSource, dependencyArray.match, nextDependencies);
    nextSource = replaceTomlArrayLine(
        nextSource,
        parseTomlArrayLine(nextSource, 'dev').match,
        nextDevDependencies,
    );

    return {
        changes: changes.sort((left, right) => left.dependency.localeCompare(right.dependency)),
        nextSource,
    };
}

/**
 * @param {string} dependencyName
 * @param {(url: string, init?: RequestInit) => Promise<Response>} fetchImpl
 * @returns {Promise<{ versions: string[] }>}
 */
export async function fetchPythonPackageMetadata(dependencyName, fetchImpl = fetch) {
    let response;

    try {
        response = await fetchImpl(`https://pypi.org/pypi/${dependencyName}/json`, {
            headers: {
                Accept: 'application/json',
            },
        });
    } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        throw new Error(`Failed to query PyPI for "${dependencyName}": ${message}`);
    }

    if (!response.ok) {
        throw new Error(`Failed to load Python package metadata for "${dependencyName}".`);
    }

    const payload = /** @type {{ releases?: Record<string, unknown> }} */ (await response.json());
    const versions = Object.keys(payload.releases ?? {});

    if (versions.length === 0) {
        throw new Error(
            `No release history was returned for Python dependency "${dependencyName}".`,
        );
    }

    return { versions };
}

/**
 * @param {string} command
 * @param {string[]} args
 * @param {{ cwd: string; env?: NodeJS.ProcessEnv }} options
 * @returns {Promise<void>}
 */
export async function runCommand(command, args, options) {
    await execFileAsync(command, args, {
        cwd: options.cwd,
        env: options.env,
        maxBuffer: 10 * 1024 * 1024,
    });
}

/**
 * @returns {Promise<(options: Record<string, unknown>) => Promise<Record<string, string>>>}
 */
export async function loadNcuRun() {
    const ncuModule = await import('npm-check-updates');

    if (typeof ncuModule.run === 'function') {
        return ncuModule.run;
    }

    if (typeof ncuModule.default?.run === 'function') {
        return ncuModule.default.run;
    }

    if (typeof ncuModule.default === 'function') {
        return ncuModule.default;
    }

    throw new Error('Could not load npm-check-updates run() helper.');
}

/**
 * @param {{
 *   apply: boolean;
 *   includePeer: boolean;
 *   mode: 'compatible' | 'latest';
 *   rootDir: string;
 *   runNcu: (options: Record<string, unknown>) => Promise<Record<string, string>>;
 * }} options
 * @returns {Promise<Array<{ changes: DependencyChange[]; file: string }>>}
 */
export async function updateJsDependencies(options) {
    const { apply, includePeer, mode, rootDir, runNcu } = options;
    const packageFiles = await findJsPackageFiles(rootDir);
    /** @type {Array<{ changes: DependencyChange[]; file: string }>} */
    const results = [];
    const previousMaxListeners = process.getMaxListeners();
    process.setMaxListeners(Math.max(previousMaxListeners, packageFiles.length + 5));

    try {
        for (const packageFile of packageFiles) {
            const source = await readFile(packageFile, 'utf8');
            const manifest = /** @type {PackageManifest} */ (JSON.parse(source));
            const reject = collectJsRejectNames(manifest, includePeer);
            const proposed = await runNcu({
                dep: includePeer ? ['prod', 'dev', 'peer'] : ['prod', 'dev'],
                jsonUpgraded: true,
                packageFile,
                packageManager: 'pnpm',
                reject,
                silent: true,
                target: mode === 'latest' ? 'latest' : 'minor',
                upgrade: apply,
            });
            const changes = buildJsChanges(manifest, proposed, includePeer);

            if (changes.length > 0) {
                results.push({ changes, file: packageFile });
            }
        }
    } finally {
        process.setMaxListeners(previousMaxListeners);
    }

    return results;
}

/**
 * @param {{
 *   apply: boolean;
 *   includePythonPackage: boolean;
 *   mode: 'compatible' | 'latest';
 *   rootDir: string;
 *   fetchImpl?: (url: string, init?: RequestInit) => Promise<Response>;
 *   runCommandImpl?: typeof runCommand;
 * }} options
 * @returns {Promise<Array<{ changes: DependencyChange[]; file: string; needsLockRefresh: boolean }>>}
 */
export async function updatePythonDependencies(options) {
    const {
        apply,
        fetchImpl = fetch,
        includePythonPackage,
        mode,
        rootDir,
        runCommandImpl = runCommand,
    } = options;
    const projectDirs = [path.join(rootDir, 'examples', 'django')];

    if (includePythonPackage) {
        projectDirs.push(path.join(rootDir, 'packages', 'django'));
    }

    /** @type {Array<{ changes: DependencyChange[]; file: string; needsLockRefresh: boolean }>} */
    const results = [];

    for (const projectDir of projectDirs) {
        const pyprojectFile = path.join(projectDir, 'pyproject.toml');
        const lockFile = path.join(projectDir, 'uv.lock');
        const source = await readFile(pyprojectFile, 'utf8');
        const lockSource = await readFile(lockFile, 'utf8');
        const dependencyNames = [
            ...new Set(
                [
                    ...parseTomlArrayLine(source, 'dependencies').items,
                    ...parseTomlArrayLine(source, 'dev').items,
                ].map((item) => parsePythonRequirement(item).name),
            ),
        ].filter((dependencyName) => !parseLocalPythonSources(source).has(dependencyName));

        /** @type {Record<string, { versions: string[] }>} */
        const packageMetadata = {};

        for (const dependencyName of dependencyNames) {
            packageMetadata[dependencyName] = await fetchPythonPackageMetadata(
                dependencyName,
                fetchImpl,
            );
        }

        const plan = planPythonManifestUpdate({
            lockSource,
            mode,
            packageMetadata,
            source,
        });

        if (plan.changes.length === 0) {
            continue;
        }

        if (apply) {
            await writeFile(pyprojectFile, plan.nextSource, 'utf8');
            await runCommandImpl('uv', ['lock', '--upgrade'], {
                cwd: projectDir,
                env: UV_ENV,
            });
        }

        results.push({
            changes: plan.changes,
            file: pyprojectFile,
            needsLockRefresh: apply,
        });
    }

    return results;
}

/**
 * @param {string} title
 * @param {Array<{ changes: DependencyChange[]; file: string }>} results
 * @returns {string}
 */
export function formatResults(title, results) {
    const lines = [title];

    if (results.length === 0) {
        lines.push('  none');
        return lines.join('\n');
    }

    for (const result of results) {
        lines.push(`  ${path.relative(process.cwd(), result.file)}`);

        for (const change of result.changes) {
            lines.push(`    ${change.dependency}: ${change.previous} -> ${change.next}`);
        }
    }

    return lines.join('\n');
}

/**
 * @param {CliOptions} options
 * @returns {Promise<void>}
 */
export async function runUpgradeWorkflow(options) {
    const rootDir = process.cwd();
    const runNcu = await loadNcuRun();
    const jsResults = await updateJsDependencies({
        apply: options.apply,
        includePeer: options.includePeer,
        mode: options.mode,
        rootDir,
        runNcu,
    });
    const pythonResults = await updatePythonDependencies({
        apply: options.apply,
        includePythonPackage: options.includePythonPackage,
        mode: options.mode,
        rootDir,
    });

    if (options.apply && jsResults.length > 0) {
        await runCommand('pnpm', ['install', '--lockfile-only'], {
            cwd: rootDir,
            env: process.env,
        });
    }

    console.log(`Mode: ${options.mode}${options.apply ? ' (apply)' : ' (preview)'}`);
    console.log(formatResults('JS', jsResults));
    console.log(formatResults('Python', pythonResults));
}

if (import.meta.url === `file://${process.argv[1]}`) {
    runUpgradeWorkflow(parseCliArgs(process.argv.slice(2))).catch((error) => {
        const message = error instanceof Error ? error.message : String(error);
        console.error(message);
        process.exitCode = 1;
    });
}
