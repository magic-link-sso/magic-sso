// SPDX-License-Identifier: MIT
import { rm } from 'node:fs/promises';
import { basename, dirname, resolve } from 'node:path';
import { tmpdir } from 'node:os';
export default async function teardown(): Promise<void> {
    const directory = process.env.MAGICSSO_E2E_TLS_DIR;
    if (
        directory &&
        basename(directory).startsWith('magic-sso-https-e2e-') &&
        resolve(dirname(directory)) === resolve(tmpdir())
    ) {
        await rm(directory, { recursive: true, force: true });
    }
}
