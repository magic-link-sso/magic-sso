// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Wojciech Polak

import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { tmpdir } from 'node:os';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
    buildJsChanges,
    buildBoundedRequirement,
    collectJsRejectNames,
    parseTomlArrayLine,
    parseUvLockVersions,
    planPythonManifestUpdate,
    updatePythonDependencies,
} from './upgrade-deps.mjs';

const fixtureDir = path.join(import.meta.dirname, 'fixtures');

async function readFixture(fileName: string): Promise<string> {
    return readFile(path.join(fixtureDir, fileName), 'utf8');
}

describe('JS dependency planning', () => {
    it('skips peer dependencies unless explicitly requested', async () => {
        const manifest = JSON.parse(await readFixture('sample-js-package.json'));
        const reject = collectJsRejectNames(manifest, false);

        expect(reject).toContain('peer-dep');
        expect(reject).toContain('latest-dep');
        expect(reject).toContain('workspace-dep');
        expect(reject).not.toContain('caret-dep');
        expect(reject).not.toContain('tilde-dep');
    });

    it('builds changes for exact, caret, and tilde upgrades while ignoring skipped specs', async () => {
        const manifest = JSON.parse(await readFixture('sample-js-package.json'));
        const changes = buildJsChanges(
            manifest,
            {
                'caret-dep': '^1.9.0',
                'exact-dep': '2.3.9',
                'tilde-dep': '~3.4.8',
            },
            false,
        );

        expect(changes).toEqual([
            { dependency: 'caret-dep', next: '^1.9.0', previous: '^1.2.3' },
            { dependency: 'exact-dep', next: '2.3.9', previous: '2.3.4' },
            { dependency: 'tilde-dep', next: '~3.4.8', previous: '~3.4.5' },
        ]);
    });
});

describe('Python dependency planning', () => {
    it('parses locked versions from uv.lock fixtures', async () => {
        const versions = parseUvLockVersions(await readFixture('sample-python-uv.lock'));

        expect(versions).toMatchObject({
            django: '5.2.1',
            pytest: '8.3.5',
            ruff: '0.11.8',
            ty: '0.0.1a7',
        });
    });

    it('builds bounded requirements for compatible and latest upgrades', () => {
        expect(buildBoundedRequirement('5.2.6')).toBe('>=5.2.6,<6');
        expect(buildBoundedRequirement('8.4.0')).toBe('>=8.4.0,<9');
    });

    it('plans compatible Python upgrades from fixtures without mutating local path deps', async () => {
        const pyproject = await readFixture('sample-python-pyproject.toml');
        const lock = await readFixture('sample-python-uv.lock');
        const plan = planPythonManifestUpdate({
            lockSource: lock,
            mode: 'compatible',
            packageMetadata: {
                django: { versions: ['5.2.1', '5.2.6', '6.0.0'] },
                pytest: { versions: ['8.3.5', '8.4.2', '9.0.0'] },
                ruff: { versions: ['0.11.8', '0.11.10', '1.0.0'] },
                ty: { versions: ['0.0.1a7', '0.0.2', '1.0.0'] },
            },
            source: pyproject,
        });

        expect(plan.changes).toEqual([
            { dependency: 'django', next: 'django>=5.2.6,<6', previous: 'django>=5.0.7' },
            { dependency: 'pytest', next: 'pytest>=8.4.2,<9', previous: 'pytest' },
            { dependency: 'ruff', next: 'ruff>=0.11.10,<1', previous: 'ruff' },
            { dependency: 'ty', next: 'ty>=0.0.2,<1', previous: 'ty' },
        ]);
        expect(parseTomlArrayLine(plan.nextSource, 'dependencies').items).toEqual([
            'django>=5.2.6,<6',
            'magic-link-sso-django',
        ]);
        expect(parseTomlArrayLine(plan.nextSource, 'dev').items).toEqual([
            'pytest>=8.4.2,<9',
            'ruff>=0.11.10,<1',
            'ty>=0.0.2,<1',
        ]);
    });

    it('keeps preview mode read-only and skips packages/django unless opted in', async () => {
        const tempRoot = await mkdtemp(path.join(tmpdir(), 'magic-sso-upgrade-'));
        const exampleDir = path.join(tempRoot, 'examples', 'django');
        const packageDir = path.join(tempRoot, 'packages', 'django');
        await mkdir(exampleDir, { recursive: true });
        await mkdir(packageDir, { recursive: true });

        const pyprojectFixture = await readFixture('sample-python-pyproject.toml');
        const lockFixture = await readFixture('sample-python-uv.lock');
        await writeFile(path.join(exampleDir, 'pyproject.toml'), pyprojectFixture, 'utf8');
        await writeFile(path.join(exampleDir, 'uv.lock'), lockFixture, 'utf8');
        await writeFile(path.join(packageDir, 'pyproject.toml'), pyprojectFixture, 'utf8');
        await writeFile(path.join(packageDir, 'uv.lock'), lockFixture, 'utf8');

        const fetchImpl = vi.fn(async (url: string) => {
            const dependencyName = url.split('/').at(-2);
            const versions =
                dependencyName === 'django'
                    ? ['5.2.1', '5.2.6', '6.0.0']
                    : dependencyName === 'pytest'
                      ? ['8.3.5', '8.4.2', '9.0.0']
                      : dependencyName === 'ruff'
                        ? ['0.11.8', '0.11.10', '1.0.0']
                        : ['0.0.1a7', '0.0.2', '1.0.0'];

            return new Response(
                JSON.stringify({
                    releases: Object.fromEntries(versions.map((version) => [version, []])),
                }),
                {
                    status: 200,
                },
            );
        });
        const runCommandImpl = vi.fn();

        const results = await updatePythonDependencies({
            apply: false,
            fetchImpl,
            includePythonPackage: false,
            mode: 'compatible',
            rootDir: tempRoot,
            runCommandImpl,
        });

        expect(results).toHaveLength(1);
        expect(results[0]?.file).toBe(path.join(exampleDir, 'pyproject.toml'));
        expect(runCommandImpl).not.toHaveBeenCalled();
        expect(await readFile(path.join(exampleDir, 'pyproject.toml'), 'utf8')).toBe(
            pyprojectFixture,
        );
        expect(await readFile(path.join(packageDir, 'pyproject.toml'), 'utf8')).toBe(
            pyprojectFixture,
        );
    });
});

afterEach(() => {
    vi.restoreAllMocks();
});
