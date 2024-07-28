import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { tmpdir } from 'node:os';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
    bumpVersion,
    formatVersionChanges,
    parseCliArgs,
    replaceJsonVersion,
    replaceTomlVersion,
    replaceUvLockPackageVersion,
} from './bump-version.mjs';
import {
    findCurrentReleaseVersion,
    incrementVersion,
    resolveReleaseVersion,
} from './release-metadata.mjs';

function indentLines(source: string, prefix: string): string {
    return source
        .trim()
        .split('\n')
        .map((line) => `${prefix}${line.trimStart()}`)
        .join('\n');
}

async function writeWorkspace(rootDir: string): Promise<void> {
    const files: Array<[string, string]> = [
        [
            'packages/angular/package.json',
            '{\n    "name": "@magic-link-sso/angular",\n    "version": "1.0.0"\n}\n',
        ],
        [
            'packages/example-ui/package.json',
            '{\n    "name": "magic-sso-example-ui",\n    "version": "1.0.0"\n}\n',
        ],
        [
            'packages/nextjs/package.json',
            '{\n    "name": "@magic-link-sso/nextjs",\n    "version": "1.0.0"\n}\n',
        ],
        [
            'packages/nuxt/package.json',
            '{\n    "name": "@magic-link-sso/nuxt",\n    "version": "1.0.0"\n}\n',
        ],
        ['server/package.json', '{\n    "name": "magic-sso-server",\n    "version": "1.0.0"\n}\n'],
        [
            'packages/django/pyproject.toml',
            indentLines(
                `
                [project]
                name = "magic-link-sso-django"
                version = "1.0.0"

                [tool.ty]
                `,
                '',
            ),
        ],
        [
            'packages/django/uv.lock',
            indentLines(
                `
                [[package]]
                name = "magic-link-sso-django"
                version = "1.0.0"
                `,
                '',
            ),
        ],
        [
            'examples/django/pyproject.toml',
            indentLines(
                `
                [project]
                name = "example-app-django"
                version = "1.0.0"

                [tool.ty]
                `,
                '',
            ),
        ],
        [
            'examples/django/uv.lock',
            indentLines(
                `
                [[package]]
                name = "example-app-django"
                version = "1.0.0"

                [[package]]
                name = "magic-link-sso-django"
                version = "1.0.0"
                `,
                '',
            ),
        ],
    ];

    for (const [relativePath, contents] of files) {
        const absolutePath = path.join(rootDir, relativePath);
        await mkdir(path.dirname(absolutePath), { recursive: true });
        await writeFile(absolutePath, contents, 'utf8');
    }
}

describe('version bump helpers', () => {
    it('parses the version bump command line', () => {
        expect(parseCliArgs(['0.9.0'])).toEqual({ apply: false, versionSpecifier: '0.9.0' });
        expect(parseCliArgs(['minor', '--apply'])).toEqual({
            apply: true,
            versionSpecifier: 'minor',
        });
        expect(parseCliArgs(['--', 'patch', '--apply'])).toEqual({
            apply: true,
            versionSpecifier: 'patch',
        });
    });

    it('updates JSON, TOML, and uv.lock version strings', () => {
        expect(replaceJsonVersion('{\n    "version": "1.0.0"\n}\n', '0.9.0')).toBe(
            '{\n    "version": "0.9.0"\n}\n',
        );
        expect(replaceTomlVersion('version = "1.0.0"\n', '0.9.0')).toBe('version = "0.9.0"\n');
        expect(
            replaceUvLockPackageVersion(
                '[[package]]\nname = "magic-link-sso-django"\nversion = "1.0.0"\n',
                'magic-link-sso-django',
                '0.9.0',
            ),
        ).toBe('[[package]]\nname = "magic-link-sso-django"\nversion = "0.9.0"\n');
    });

    it('finds and increments the current managed release version', async () => {
        const rootDir = await mkdtemp(path.join(tmpdir(), 'magic-sso-version-resolve-'));
        await writeWorkspace(rootDir);

        expect(
            findCurrentReleaseVersion([
                { file: 'packages/angular/package.json', version: '1.0.0' },
                { file: 'packages/nextjs/package.json', version: '1.0.0' },
            ]),
        ).toBe('1.0.0');
        expect(incrementVersion('1.0.0', 'major')).toBe('2.0.0');
        expect(incrementVersion('1.0.0', 'minor')).toBe('1.1.0');
        expect(incrementVersion('1.0.0', 'patch')).toBe('1.0.1');
        await expect(resolveReleaseVersion(rootDir, 'minor')).resolves.toBe('1.1.0');
    });
});

describe('version bump workflow', () => {
    it('updates the release metadata files consistently', async () => {
        const rootDir = await mkdtemp(path.join(tmpdir(), 'magic-sso-version-'));
        await writeWorkspace(rootDir);

        const changes = await bumpVersion({
            apply: true,
            nextVersion: '0.9.0',
            rootDir,
        });

        expect(formatVersionChanges(changes)).toContain('0.9.0');
        expect(
            await readFile(path.join(rootDir, 'packages/angular/package.json'), 'utf8'),
        ).toContain('"version": "0.9.0"');
        expect(
            await readFile(path.join(rootDir, 'packages/example-ui/package.json'), 'utf8'),
        ).toContain('"version": "0.9.0"');
        expect(
            await readFile(path.join(rootDir, 'packages/nextjs/package.json'), 'utf8'),
        ).toContain('"version": "0.9.0"');
        expect(await readFile(path.join(rootDir, 'packages/nuxt/package.json'), 'utf8')).toContain(
            '"version": "0.9.0"',
        );
        expect(await readFile(path.join(rootDir, 'server/package.json'), 'utf8')).toContain(
            '"version": "0.9.0"',
        );
        expect(
            await readFile(path.join(rootDir, 'packages/django/pyproject.toml'), 'utf8'),
        ).toContain('version = "0.9.0"');
        expect(await readFile(path.join(rootDir, 'packages/django/uv.lock'), 'utf8')).toContain(
            'version = "0.9.0"',
        );
        expect(
            await readFile(path.join(rootDir, 'examples/django/pyproject.toml'), 'utf8'),
        ).toContain('version = "0.9.0"');
        expect(await readFile(path.join(rootDir, 'examples/django/uv.lock'), 'utf8')).toContain(
            'name = "example-app-django"\nversion = "0.9.0"',
        );
        expect(await readFile(path.join(rootDir, 'examples/django/uv.lock'), 'utf8')).toContain(
            'name = "magic-link-sso-django"\nversion = "0.9.0"',
        );
    });

    it('does not write files when run in preview mode', async () => {
        const rootDir = await mkdtemp(path.join(tmpdir(), 'magic-sso-version-preview-'));
        await writeWorkspace(rootDir);
        const packageJsonPath = path.join(rootDir, 'packages/angular/package.json');

        const changes = await bumpVersion({
            apply: false,
            nextVersion: '0.9.0',
            rootDir,
        });

        expect(changes).toHaveLength(10);
        expect(await readFile(packageJsonPath, 'utf8')).toContain('"version": "1.0.0"');
    });
});

afterEach(() => {
    vi.restoreAllMocks();
});
