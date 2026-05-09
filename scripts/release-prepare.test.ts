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

const jsReleasePackages: Array<[string, string]> = [
    ['gate/package.json', 'magic-sso-gate'],
    ['manager/package.json', 'magic-sso-manager'],
    ['packages/config-core/package.json', '@magic-link-sso/config-core'],
    ['packages/angular/package.json', '@magic-link-sso/angular'],
    ['packages/example-ui/package.json', 'magic-sso-example-ui'],
    ['packages/nextjs/package.json', '@magic-link-sso/nextjs'],
    ['packages/nuxt/package.json', '@magic-link-sso/nuxt'],
    ['server/package.json', 'magic-sso-server'],
    ['examples/angular/package.json', 'example-app-angular'],
    ['examples/fastify/package.json', 'example-app-fastify'],
    ['examples/gate-private1-app/package.json', 'example-app-gate-private1'],
    ['examples/gate-private2-static/package.json', 'example-app-gate-private2-static'],
    ['examples/nextjs/package.json', 'example-app-nextjs'],
    ['examples/nuxt/package.json', 'example-app-nuxt'],
    ['examples/photos/package.json', 'example-app-photos'],
];

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
        ...jsReleasePackages.map(([relativePath, packageName]) => [
            relativePath,
            `{\n    "name": "${packageName}",\n    "version": "1.0.0"\n}\n`,
        ]),
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
        expect(result.versionChanges).toHaveLength(20);
        expect(await readFile(path.join(rootDir, 'CHANGELOG.md'), 'utf8')).toContain(
            '## [0.9.0] - 2026-04-25',
        );
        expect(await readFile(path.join(rootDir, 'gate/package.json'), 'utf8')).toContain(
            '"version": "0.9.0"',
        );
        expect(
            await readFile(path.join(rootDir, 'examples/django/pyproject.toml'), 'utf8'),
        ).toContain('version = "0.9.0"');
        expect(execFileImpl).toHaveBeenCalledTimes(1);
    });
});
