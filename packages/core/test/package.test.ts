// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Wojciech Polak

import { execFile } from 'node:child_process';
import { access, mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { build } from 'esbuild';
import { describe, expect, it } from 'vitest';

interface PackageExport {
    default: string;
    types: string;
}

interface PackedFile {
    path: string;
}

interface PackedPackage {
    files: PackedFile[];
}

const execFileAsync = promisify(execFile);
const packageDirectory = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const packageLifecycleTimeout = 30_000;

async function readPackageJson(): Promise<{
    exports: Record<string, PackageExport>;
}> {
    return JSON.parse(await readFile(resolve(packageDirectory, 'package.json'), 'utf8')) as {
        exports: Record<string, PackageExport>;
    };
}

async function inspectPack(): Promise<PackedPackage> {
    const { stdout } = await execFileAsync('npm', ['pack', '--json', '--dry-run'], {
        cwd: packageDirectory,
        env: { ...process.env, npm_config_cache: resolve(tmpdir(), 'magic-link-sso-npm-cache') },
    });
    const result = JSON.parse(stdout) as PackedPackage[];
    const packedPackage = result[0];
    if (packedPackage === undefined) {
        throw new Error('npm pack --dry-run did not return package metadata.');
    }
    return packedPackage;
}

async function packPackage(destination: string): Promise<string> {
    const { stdout } = await execFileAsync(
        'npm',
        ['pack', '--json', '--pack-destination', destination],
        {
            cwd: packageDirectory,
            env: {
                ...process.env,
                npm_config_cache: resolve(tmpdir(), 'magic-link-sso-npm-cache'),
            },
        },
    );
    const result = JSON.parse(stdout) as Array<PackedPackage & { filename?: string }>;
    const filename = result[0]?.filename;
    if (typeof filename !== 'string') {
        throw new Error('npm pack did not return a tarball filename.');
    }
    return resolve(destination, filename);
}

describe('@magic-link-sso/core package', () => {
    it('ships working exports with declarations and a portable entrypoint', async () => {
        const packageJson = await readPackageJson();

        for (const entrypoint of Object.values(packageJson.exports)) {
            await expect(
                access(resolve(packageDirectory, entrypoint.default)),
            ).resolves.toBeUndefined();
            await expect(
                access(resolve(packageDirectory, entrypoint.types)),
            ).resolves.toBeUndefined();
        }

        const portableEntrypoint = await readFile(
            resolve(packageDirectory, 'dist/index.js'),
            'utf8',
        );
        expect(portableEntrypoint).not.toContain('node:');
    });

    it(
        'packs only build artifacts and public documentation',
        async () => {
            const packedPackage = await inspectPack();
            const paths = packedPackage.files.map((file) => file.path);

            expect(paths).toEqual(
                expect.arrayContaining([
                    'LICENSE',
                    'README.md',
                    'dist/index.d.ts',
                    'dist/index.js',
                    'package.json',
                ]),
            );
            expect(paths.some((path) => path.startsWith('src/'))).toBe(false);
            expect(paths.some((path) => path.startsWith('test/'))).toBe(false);
        },
        packageLifecycleTimeout,
    );

    it('bundles the portable entrypoint for a Web runtime without Node imports', async () => {
        const result = await build({
            bundle: true,
            entryPoints: [resolve(packageDirectory, 'dist/index.js')],
            format: 'esm',
            platform: 'browser',
            write: false,
        });
        const output = result.outputFiles[0]?.text;

        if (typeof output !== 'string') {
            throw new Error('Expected an esbuild output file.');
        }

        expect(output).not.toContain('node:');
    });

    it(
        'installs from its tarball into a clean ESM project',
        async () => {
            const temporaryDirectory = await mkdtemp(
                resolve(tmpdir(), 'magic-link-sso-core-package-'),
            );
            const tarball = await packPackage(temporaryDirectory);
            const projectDirectory = resolve(temporaryDirectory, 'consumer');
            await mkdir(projectDirectory);
            await writeFile(
                resolve(projectDirectory, 'package.json'),
                JSON.stringify({ private: true, type: 'module' }),
            );
            await execFileAsync('npm', ['install', tarball], {
                cwd: projectDirectory,
                env: {
                    ...process.env,
                    npm_config_cache: resolve(tmpdir(), 'magic-link-sso-npm-cache'),
                },
            });
            await writeFile(
                resolve(projectDirectory, 'verify.mjs'),
                "import { buildLoginTarget } from '@magic-link-sso/core';\n" +
                    "console.log(buildLoginTarget({ appOrigin: 'https://app.example.test', returnUrl: '/' }));\n",
            );

            const { stdout } = await execFileAsync('node', ['verify.mjs'], {
                cwd: projectDirectory,
            });

            expect(basename(tarball)).toMatch(/^magic-link-sso-core-.+\.tgz$/u);
            expect(stdout.trim()).toBe('/login?returnUrl=https%3A%2F%2Fapp.example.test%2F');
        },
        packageLifecycleTimeout,
    );
});
