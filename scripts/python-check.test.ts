// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Wojciech Polak

import { spawnSync } from 'node:child_process';
import {
    chmodSync,
    mkdirSync,
    mkdtempSync,
    readFileSync,
    realpathSync,
    rmSync,
    writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const projects = ['packages/django', 'examples/django'];
const targets = [
    'python-sync',
    'python-format-check',
    'python-lint',
    'python-typecheck',
    'python-test',
    'python-check',
];

describe('Python Makefile failure propagation', () => {
    it.each(
        targets.flatMap((target) =>
            ['', ...projects].map((failingProject) => ({ target, failingProject })),
        ),
    )('$target propagates failure from $failingProject', ({ target, failingProject }) => {
        const directory = realpathSync(mkdtempSync(join(tmpdir(), 'magic-sso-python-check-')));
        try {
            for (const project of projects) {
                mkdirSync(join(directory, project), { recursive: true });
            }
            const fakeUv = join(directory, 'uv');
            const log = join(directory, 'projects.log');
            writeFileSync(
                fakeUv,
                `#!/bin/sh
printf '%s\\n' "$PWD" >> "$MAGICSSO_TEST_UV_LOG"
if [ -n "$MAGICSSO_TEST_FAIL_PROJECT" ] && [ "$PWD" = "$MAGICSSO_TEST_ROOT/$MAGICSSO_TEST_FAIL_PROJECT" ]; then
    exit 17
fi
exit 0
`,
            );
            chmodSync(fakeUv, 0o755);
            const result = spawnSync('make', ['-f', resolve('Makefile'), target, `UV=${fakeUv}`], {
                cwd: directory,
                encoding: 'utf8',
                env: {
                    ...process.env,
                    MAGICSSO_TEST_ROOT: directory,
                    MAGICSSO_TEST_UV_LOG: log,
                    MAGICSSO_TEST_FAIL_PROJECT: failingProject,
                },
            });
            expect(result.error).toBeUndefined();
            const expected =
                failingProject === '' && target === 'python-check'
                    ? Array.from({ length: 4 }, () => projects).flat()
                    : failingProject === ''
                      ? projects
                      : projects.slice(0, projects.indexOf(failingProject) + 1);
            expect(readFileSync(log, 'utf8').trim().split('\n')).toEqual(
                expected.map((project) => join(directory, project)),
            );
            if (failingProject === '') {
                expect(result.status).toBe(0);
            } else {
                expect(result.status).toBeGreaterThan(0);
            }
        } finally {
            rmSync(directory, { recursive: true, force: true });
        }
    });
});
