import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { bumpVersion, formatVersionChanges } from './bump-version.mjs';
import { CHANGELOG_FILE, writeReleaseChangelog } from './changelog.mjs';
import {
    VERSION_BUMP_PATTERN,
    VERSION_PATTERN,
    resolveReleaseVersion,
    stripCliSeparators,
} from './release-metadata.mjs';

export function parseCliArgs(argv) {
    const [versionSpecifier] = stripCliSeparators(argv);

    if (
        typeof versionSpecifier === 'string' &&
        (VERSION_PATTERN.test(versionSpecifier) || VERSION_BUMP_PATTERN.test(versionSpecifier))
    ) {
        return { versionSpecifier };
    }

    throw new Error('Usage: node scripts/release-prepare.mjs <version|major|minor|patch>');
}

export function formatLocalDate(date = new Date()) {
    const year = String(date.getFullYear());
    const month = String(date.getMonth() + 1).padStart(2, '0');
    const day = String(date.getDate()).padStart(2, '0');

    return `${year}-${month}-${day}`;
}

export function validatePreparedRelease(changelogSource, version, releaseDate) {
    const expectedHeading = `## [${version}] - ${releaseDate}`;

    if (!changelogSource.includes(expectedHeading)) {
        throw new Error(`Expected CHANGELOG.md to contain "${expectedHeading}".`);
    }

    return expectedHeading;
}

export async function prepareRelease({ date = new Date(), execFileImpl, rootDir, version }) {
    await writeReleaseChangelog({
        execFileImpl,
        rootDir,
        version,
    });

    const versionChanges = await bumpVersion({
        apply: true,
        nextVersion: version,
        rootDir,
    });

    const changelogSource = await readFile(path.join(rootDir, CHANGELOG_FILE), 'utf8');
    const releaseHeading = validatePreparedRelease(changelogSource, version, formatLocalDate(date));

    return {
        releaseHeading,
        versionChanges,
    };
}

export async function main() {
    const { versionSpecifier } = parseCliArgs(process.argv.slice(2));
    const rootDir = process.cwd();
    const version = await resolveReleaseVersion(rootDir, versionSpecifier);
    const { releaseHeading, versionChanges } = await prepareRelease({
        rootDir,
        version,
    });

    console.log(releaseHeading);
    console.log(formatVersionChanges(versionChanges));
}

if (import.meta.url === `file://${process.argv[1]}`) {
    await main();
}
