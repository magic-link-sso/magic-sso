import { readManagedReleaseVersions, TAG_VERSION_PATTERN } from './release-metadata.mjs';

export function parseReleaseTag(tagName) {
    const match = TAG_VERSION_PATTERN.exec(tagName);

    if (!match?.[1]) {
        throw new Error(`Expected a release tag in the form "v<version>", received "${tagName}".`);
    }

    return match[1];
}

export function assertReleaseVersionMatchesTag(versionEntries, tagVersion) {
    const mismatches = versionEntries.filter((entry) => entry.version !== tagVersion);

    if (mismatches.length > 0) {
        const details = mismatches
            .map((entry) => `${entry.file}: expected ${tagVersion}, found ${entry.version}`)
            .join('\n');
        throw new Error(`Release metadata does not match tag v${tagVersion}:\n${details}`);
    }
}

export async function verifyReleaseTag({ rootDir, tagName }) {
    const tagVersion = parseReleaseTag(tagName);
    const versionEntries = await readManagedReleaseVersions(rootDir);

    assertReleaseVersionMatchesTag(versionEntries, tagVersion);

    return {
        checkedFiles: versionEntries.length,
        tagVersion,
    };
}

export async function main() {
    const tagName = process.argv[2] ?? process.env.GITHUB_REF_NAME;

    if (!tagName) {
        throw new Error('Usage: node scripts/verify-release-tag.mjs <tag>');
    }

    const result = await verifyReleaseTag({
        rootDir: process.cwd(),
        tagName,
    });

    console.log(
        `Verified ${result.checkedFiles} managed release version fields against v${result.tagVersion}.`,
    );
}

if (import.meta.url === `file://${process.argv[1]}`) {
    await main();
}
