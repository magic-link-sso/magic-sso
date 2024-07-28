import { execFile } from 'node:child_process';
import { readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { promisify } from 'node:util';
import {
    VERSION_BUMP_PATTERN,
    VERSION_PATTERN,
    resolveReleaseVersion,
    stripCliSeparators,
} from './release-metadata.mjs';

const execFileAsync = promisify(execFile);

export const CHANGELOG_FILE = 'CHANGELOG.md';
export const CLIFF_CONFIG_FILE = 'cliff.toml';

function getPnpmCommand() {
    return process.platform === 'win32' ? 'pnpm.cmd' : 'pnpm';
}

export function parseCliArgs(argv) {
    const [command, versionSpecifier] = stripCliSeparators(argv);

    if (command === 'preview') {
        return { command };
    }

    if (
        command === 'release' &&
        typeof versionSpecifier === 'string' &&
        (VERSION_PATTERN.test(versionSpecifier) || VERSION_BUMP_PATTERN.test(versionSpecifier))
    ) {
        return { command, versionSpecifier };
    }

    throw new Error(
        'Usage: node scripts/changelog.mjs <preview|release> [version|major|minor|patch]',
    );
}

/**
 * @param {{ version?: string }} options
 * @returns {string[]}
 */
export function buildGitCliffArgs({ version }) {
    const args = [
        'exec',
        'git-cliff',
        '--config',
        CLIFF_CONFIG_FILE,
        '--unreleased',
        '--strip',
        'header',
        '--no-exec',
        '--offline',
    ];

    if (typeof version === 'string') {
        args.push('--tag', version);
    }

    return args;
}

export function normalizeRenderedSection(source) {
    return `${source.trim()}\n`;
}

export function insertReleaseSection(changelogSource, renderedSection, version) {
    if (changelogSource.includes(`## [${version}] - `)) {
        throw new Error(`CHANGELOG.md already contains version "${version}".`);
    }

    const section = normalizeRenderedSection(renderedSection);
    const firstReleaseHeadingIndex = changelogSource.search(/^## \[/mu);

    if (firstReleaseHeadingIndex === -1) {
        return `${changelogSource.trimEnd()}\n\n${section}`;
    }

    const prefix = changelogSource.slice(0, firstReleaseHeadingIndex).trimEnd();
    const suffix = changelogSource.slice(firstReleaseHeadingIndex).trimStart();

    return `${prefix}\n\n${section}\n${suffix}`;
}

export async function renderUnreleasedSection({ execFileImpl = execFileAsync, rootDir, version }) {
    const { stdout } = await execFileImpl(getPnpmCommand(), buildGitCliffArgs({ version }), {
        cwd: rootDir,
        maxBuffer: 1024 * 1024 * 8,
    });

    return stdout;
}

export async function previewChangelog({ execFileImpl = execFileAsync, rootDir }) {
    return renderUnreleasedSection({
        execFileImpl,
        rootDir,
    });
}

export async function writeReleaseChangelog({ execFileImpl = execFileAsync, rootDir, version }) {
    const changelogPath = path.join(rootDir, CHANGELOG_FILE);
    const currentChangelog = await readFile(changelogPath, 'utf8');
    const renderedSection = await renderUnreleasedSection({
        execFileImpl,
        rootDir,
        version,
    });
    const nextChangelog = insertReleaseSection(currentChangelog, renderedSection, version);

    await writeFile(changelogPath, nextChangelog, 'utf8');
    return nextChangelog;
}

export async function main() {
    const parsed = parseCliArgs(process.argv.slice(2));
    const rootDir = process.cwd();

    if (parsed.command === 'preview') {
        process.stdout.write(await previewChangelog({ rootDir }));
        return;
    }

    await writeReleaseChangelog({
        rootDir,
        version: await resolveReleaseVersion(rootDir, parsed.versionSpecifier),
    });
    console.log(`Updated ${CHANGELOG_FILE}.`);
}

if (import.meta.url === `file://${process.argv[1]}`) {
    await main();
}
