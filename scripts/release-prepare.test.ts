import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { tmpdir } from 'node:os';
import { describe, expect, it, vi } from 'vitest';
import {
    formatLocalDate,
    parseCliArgs,
    prepareRelease,
    validatePreparedRelease,
} from './release-prepare.mjs';

async function writeReleaseWorkspace(rootDir: string): Promise<void> {
    const files: Array<[string, string]> = [
        [
            'CHANGELOG.md',
            `# Changelog

All notable changes to Magic Link SSO will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project follows
[Semantic Versioning](https://semver.org/spec/v2.0.0.html) for public releases.
`,
        ],
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
            '[project]\nname = "magic-link-sso-django"\nversion = "1.0.0"\n',
        ],
        [
            'packages/django/uv.lock',
            '[[package]]\nname = "magic-link-sso-django"\nversion = "1.0.0"\n',
        ],
        [
            'examples/django/pyproject.toml',
            '[project]\nname = "example-app-django"\nversion = "1.0.0"\n',
        ],
        [
            'examples/django/uv.lock',
            '[[package]]\nname = "example-app-django"\nversion = "1.0.0"\n\n[[package]]\nname = "magic-link-sso-django"\nversion = "1.0.0"\n',
        ],
    ];

    for (const [relativePath, contents] of files) {
        const absolutePath = path.join(rootDir, relativePath);
        await mkdir(path.dirname(absolutePath), { recursive: true });
        await writeFile(absolutePath, contents, 'utf8');
    }
}

describe('release preparation', () => {
    it('parses an explicit version or an automatic bump specifier', () => {
        expect(parseCliArgs(['0.9.0'])).toEqual({ versionSpecifier: '0.9.0' });
        expect(parseCliArgs(['patch'])).toEqual({ versionSpecifier: 'patch' });
        expect(parseCliArgs(['--', 'minor'])).toEqual({ versionSpecifier: 'minor' });
    });

    it('formats release dates using the local calendar date', () => {
        expect(formatLocalDate(new Date('2026-04-25T12:34:56'))).toBe('2026-04-25');
    });

    it('validates the prepared changelog heading', () => {
        expect(validatePreparedRelease('## [0.9.0] - 2026-04-25\n', '0.9.0', '2026-04-25')).toBe(
            '## [0.9.0] - 2026-04-25',
        );
    });

    it('writes the release changelog and bumps managed versions together', async () => {
        const rootDir = await mkdtemp(path.join(tmpdir(), 'magic-sso-release-prepare-'));
        await writeReleaseWorkspace(rootDir);
        const execFileImpl = vi.fn().mockResolvedValue({
            stdout: '\n## [0.9.0] - 2026-04-25\n\n### Added\n- Release automation\n',
        });

        const result = await prepareRelease({
            date: new Date('2026-04-25T12:00:00'),
            execFileImpl,
            rootDir,
            version: '0.9.0',
        });

        expect(result.releaseHeading).toBe('## [0.9.0] - 2026-04-25');
        expect(result.versionChanges).toHaveLength(10);
        expect(await readFile(path.join(rootDir, 'CHANGELOG.md'), 'utf8')).toContain(
            '## [0.9.0] - 2026-04-25',
        );
        expect(
            await readFile(path.join(rootDir, 'packages/angular/package.json'), 'utf8'),
        ).toContain('"version": "0.9.0"');
        expect(
            await readFile(path.join(rootDir, 'examples/django/pyproject.toml'), 'utf8'),
        ).toContain('version = "0.9.0"');
        expect(execFileImpl).toHaveBeenCalledTimes(1);
    });
});
