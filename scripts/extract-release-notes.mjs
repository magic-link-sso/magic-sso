import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { TAG_VERSION_PATTERN, VERSION_PATTERN } from './release-metadata.mjs';

export function normalizeReleaseIdentifier(identifier) {
    if (VERSION_PATTERN.test(identifier)) {
        return identifier;
    }

    const tagMatch = TAG_VERSION_PATTERN.exec(identifier);

    if (tagMatch?.[1]) {
        return tagMatch[1];
    }

    throw new Error(`Expected a release version or tag, received "${identifier}".`);
}

export function extractReleaseNotes(source, identifier) {
    const version = normalizeReleaseIdentifier(identifier);
    const lines = source.split('\n');
    const heading = `## [${version}] - `;
    const startIndex = lines.findIndex((line) => line.startsWith(heading));

    if (startIndex === -1) {
        throw new Error(`Could not find release notes for version "${version}".`);
    }

    let endIndex = lines.length;

    for (let index = startIndex + 1; index < lines.length; index += 1) {
        if (lines[index].startsWith('## [')) {
            endIndex = index;
            break;
        }
    }

    return `${lines.slice(startIndex, endIndex).join('\n').trim()}\n`;
}

export async function readReleaseNotes({ identifier, rootDir }) {
    const changelogSource = await readFile(path.join(rootDir, 'CHANGELOG.md'), 'utf8');
    return extractReleaseNotes(changelogSource, identifier);
}

export async function main() {
    const identifier = process.argv[2] ?? process.env.GITHUB_REF_NAME;

    if (!identifier) {
        throw new Error('Usage: node scripts/extract-release-notes.mjs <version-or-tag>');
    }

    process.stdout.write(
        await readReleaseNotes({
            identifier,
            rootDir: process.cwd(),
        }),
    );
}

if (import.meta.url === `file://${process.argv[1]}`) {
    await main();
}
