import { mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { tmpdir } from 'node:os';
import { describe, expect, it } from 'vitest';
import {
    assertReleaseVersionMatchesTag,
    parseReleaseTag,
    verifyReleaseTag,
} from './verify-release-tag.mjs';

async function writeVersionWorkspace(rootDir: string, version: string): Promise<void> {
    const files: Array<[string, string]> = [
        [
            'packages/angular/package.json',
            `{\n    "name": "@magic-link-sso/angular",\n    "version": "${version}"\n}\n`,
        ],
        [
            'packages/example-ui/package.json',
            `{\n    "name": "magic-sso-example-ui",\n    "version": "${version}"\n}\n`,
        ],
        [
            'packages/nextjs/package.json',
            `{\n    "name": "@magic-link-sso/nextjs",\n    "version": "${version}"\n}\n`,
        ],
        [
            'packages/nuxt/package.json',
            `{\n    "name": "@magic-link-sso/nuxt",\n    "version": "${version}"\n}\n`,
        ],
        [
            'server/package.json',
            `{\n    "name": "magic-sso-server",\n    "version": "${version}"\n}\n`,
        ],
        [
            'packages/django/pyproject.toml',
            `[project]\nname = "magic-link-sso-django"\nversion = "${version}"\n`,
        ],
        [
            'packages/django/uv.lock',
            `[[package]]\nname = "magic-link-sso-django"\nversion = "${version}"\n`,
        ],
        [
            'examples/django/pyproject.toml',
            `[project]\nname = "example-app-django"\nversion = "${version}"\n`,
        ],
        [
            'examples/django/uv.lock',
            `[[package]]\nname = "example-app-django"\nversion = "${version}"\n\n[[package]]\nname = "magic-link-sso-django"\nversion = "${version}"\n`,
        ],
    ];

    for (const [relativePath, contents] of files) {
        const absolutePath = path.join(rootDir, relativePath);
        await mkdir(path.dirname(absolutePath), { recursive: true });
        await writeFile(absolutePath, contents, 'utf8');
    }
}

describe('release tag verification', () => {
    it('parses tags in the v<version> form', () => {
        expect(parseReleaseTag('v0.9.0')).toBe('0.9.0');
    });

    it('fails when a managed release version does not match the tag', () => {
        expect(() =>
            assertReleaseVersionMatchesTag(
                [
                    { file: 'packages/angular/package.json', version: '0.8.0' },
                    { file: 'packages/nextjs/package.json', version: '0.9.0' },
                ],
                '0.9.0',
            ),
        ).toThrow('packages/angular/package.json: expected 0.9.0, found 0.8.0');
    });

    it('verifies all managed release version fields against the tag version', async () => {
        const rootDir = await mkdtemp(path.join(tmpdir(), 'magic-sso-release-tag-'));
        await writeVersionWorkspace(rootDir, '0.9.0');

        await expect(
            verifyReleaseTag({
                rootDir,
                tagName: 'v0.9.0',
            }),
        ).resolves.toEqual({
            checkedFiles: 10,
            tagVersion: '0.9.0',
        });
    });
});
