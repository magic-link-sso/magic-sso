import { readFile } from 'node:fs/promises';
import path from 'node:path';

export const VERSION_PATTERN = /^\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?$/u;
export const TAG_VERSION_PATTERN = /^v(\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?)$/u;
export const VERSION_BUMP_PATTERN = /^(major|minor|patch)$/u;

export function stripCliSeparators(argv) {
    return argv.filter((argument) => argument !== '--');
}

export const JS_PACKAGE_FILES = [
    'packages/angular/package.json',
    'packages/example-ui/package.json',
    'packages/nextjs/package.json',
    'packages/nuxt/package.json',
    'server/package.json',
];

export const PYTHON_PROJECTS = [
    {
        lockFile: 'packages/django/uv.lock',
        packageNames: ['magic-link-sso-django'],
        pyprojectFile: 'packages/django/pyproject.toml',
    },
    {
        lockFile: 'examples/django/uv.lock',
        packageNames: ['example-app-django', 'magic-link-sso-django'],
        pyprojectFile: 'examples/django/pyproject.toml',
    },
];

export function readJsonVersion(source) {
    const parsed = JSON.parse(source);
    const version = parsed.version;

    if (typeof version !== 'string') {
        throw new Error('Expected a JSON object with a string version field.');
    }

    return version;
}

export function readTomlVersion(source) {
    const match = /^version = "([^"]+)"$/mu.exec(source);

    if (!match?.[1]) {
        throw new Error('Could not find a TOML version field.');
    }

    return match[1];
}

export function readUvLockPackageVersion(source, packageName) {
    const escapedPackageName = packageName.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&');
    const pattern = new RegExp(
        String.raw`\[\[package\]\]\nname = "${escapedPackageName}"\nversion = "([^"]+)"`,
        'm',
    );
    const match = pattern.exec(source);

    if (!match?.[1]) {
        throw new Error(`Could not find package "${packageName}" in uv.lock.`);
    }

    return match[1];
}

export async function readRepositoryFile(rootDir, relativePath) {
    return readFile(path.join(rootDir, relativePath), 'utf8');
}

export async function readManagedReleaseVersions(rootDir) {
    const versions = [];

    for (const relativePath of JS_PACKAGE_FILES) {
        const source = await readRepositoryFile(rootDir, relativePath);
        versions.push({
            file: relativePath,
            version: readJsonVersion(source),
        });
    }

    for (const { lockFile, packageNames, pyprojectFile } of PYTHON_PROJECTS) {
        const pyprojectSource = await readRepositoryFile(rootDir, pyprojectFile);
        versions.push({
            file: pyprojectFile,
            version: readTomlVersion(pyprojectSource),
        });

        const lockSource = await readRepositoryFile(rootDir, lockFile);

        for (const packageName of packageNames) {
            versions.push({
                file: `${lockFile} (${packageName})`,
                version: readUvLockPackageVersion(lockSource, packageName),
            });
        }
    }

    return versions;
}

export function findCurrentReleaseVersion(versionEntries) {
    const [firstEntry] = versionEntries;

    if (!firstEntry) {
        throw new Error('Expected at least one managed release version entry.');
    }

    const mismatches = versionEntries.filter((entry) => entry.version !== firstEntry.version);

    if (mismatches.length > 0) {
        const details = mismatches
            .map((entry) => `${entry.file}: expected ${firstEntry.version}, found ${entry.version}`)
            .join('\n');
        throw new Error(`Managed release versions are out of sync:\n${details}`);
    }

    return firstEntry.version;
}

export function incrementVersion(version, specifier) {
    if (!VERSION_BUMP_PATTERN.test(specifier)) {
        throw new Error(`Unsupported automatic version bump "${specifier}".`);
    }

    if (version.includes('-') || version.includes('+')) {
        throw new Error(
            `Automatic ${specifier} bumps require a stable x.y.z version, received "${version}".`,
        );
    }

    const match = /^(\d+)\.(\d+)\.(\d+)$/u.exec(version);

    if (!match) {
        throw new Error(`Could not parse "${version}" as a stable x.y.z version.`);
    }

    const major = Number(match[1]);
    const minor = Number(match[2]);
    const patch = Number(match[3]);

    if (specifier === 'major') {
        return `${major + 1}.0.0`;
    }

    if (specifier === 'minor') {
        return `${major}.${minor + 1}.0`;
    }

    return `${major}.${minor}.${patch + 1}`;
}

export async function resolveReleaseVersion(rootDir, versionSpecifier) {
    if (VERSION_PATTERN.test(versionSpecifier)) {
        return versionSpecifier;
    }

    if (!VERSION_BUMP_PATTERN.test(versionSpecifier)) {
        throw new Error(`Unsupported version "${versionSpecifier}".`);
    }

    const versionEntries = await readManagedReleaseVersions(rootDir);
    const currentVersion = findCurrentReleaseVersion(versionEntries);

    return incrementVersion(currentVersion, versionSpecifier);
}
