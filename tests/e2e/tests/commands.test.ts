// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Wojciech Polak

import { spawnSync } from 'node:child_process';
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

function readE2eCommand(): string {
    const manifest: unknown = JSON.parse(
        readFileSync(new URL('../package.json', import.meta.url), 'utf8'),
    );
    if (typeof manifest !== 'object' || manifest === null) {
        throw new Error('Invalid E2E package.');
    }
    const scripts: unknown = Reflect.get(manifest, 'scripts');
    if (typeof scripts !== 'object' || scripts === null) {
        throw new Error('Missing E2E scripts.');
    }
    const command: unknown = Reflect.get(scripts, 'test:e2e');
    if (typeof command !== 'string') {
        throw new Error('Missing test:e2e command.');
    }
    return command;
}

describe('standard E2E command', () => {
    it.each(['', 'test:e2e:indirect', 'test:e2e:direct', 'test:e2e:manager'])(
        'runs all suites and propagates failure from %s',
        (failingSuite) => {
            const directory = mkdtempSync(join(tmpdir(), 'magic-sso-e2e-command-'));
            try {
                const executable = join(directory, 'pnpm');
                const log = join(directory, 'commands.log');
                writeFileSync(
                    executable,
                    '#!/bin/sh\nprintf "%s\\n" "$2" >> "$MAGICSSO_TEST_COMMAND_LOG"\n[ "$2" != "$MAGICSSO_TEST_FAIL_SUITE" ]\n',
                );
                chmodSync(executable, 0o755);
                const result = spawnSync('/bin/sh', ['-c', readE2eCommand()], {
                    encoding: 'utf8',
                    env: {
                        ...process.env,
                        PATH: `${directory}:${process.env.PATH ?? ''}`,
                        MAGICSSO_TEST_COMMAND_LOG: log,
                        MAGICSSO_TEST_FAIL_SUITE: failingSuite,
                    },
                });
                const suites = ['test:e2e:indirect', 'test:e2e:direct', 'test:e2e:manager'];
                expect(result.status).toBe(failingSuite === '' ? 0 : 1);
                expect(readFileSync(log, 'utf8').trim().split('\n')).toEqual(
                    failingSuite === ''
                        ? suites
                        : suites.slice(0, suites.indexOf(failingSuite) + 1),
                );
            } finally {
                rmSync(directory, { recursive: true, force: true });
            }
        },
    );
});
