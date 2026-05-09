import { mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { tmpdir } from 'node:os';
import { describe, expect, it } from 'vitest';
import {
    assertReleaseVersionMatchesTag,
    parseReleaseTag,
    verifyReleaseTag,
} from './verify-release-tag.mjs';

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

async function writeVersionWorkspace(rootDir: string, version: string): Promise<void> {
    const files: Array<[string, string]> = [
        ...jsReleasePackages.map(([relativePath, packageName]) => [
            relativePath,
            `{\n    "name": "${packageName}",\n    "version": "${version}"\n}\n`,
        ]),
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
            checkedFiles: 20,
            tagVersion: '0.9.0',
        });
    });
});
