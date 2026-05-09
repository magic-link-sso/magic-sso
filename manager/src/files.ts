/**
 * manager/src/files.ts
 *
 * Magic Link SSO Copyright (C) 2026 Wojciech Polak
 *
 * This program is free software; you can redistribute it and/or modify it
 * under the terms of the GNU General Public License as published by the
 * Free Software Foundation; either version 3 of the License, or (at your
 * option) any later version.
 *
 * This program is distributed in the hope that it will be useful,
 * but WITHOUT ANY WARRANTY; without even the implied warranty of
 * MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE. See the
 * GNU General Public License for more details.
 *
 * You should have received a copy of the GNU General Public License along
 * with this program. If not, see <https://www.gnu.org/licenses/>.
 */

import {
    closeSync,
    fsyncSync,
    mkdirSync,
    openSync,
    renameSync,
    unlinkSync,
    writeFileSync,
} from 'node:fs';
import { randomUUID } from 'node:crypto';
import { basename, dirname, join } from 'node:path';

function ensureParentDirectory(filePath: string): void {
    mkdirSync(dirname(filePath), { recursive: true });
}

export function writeTextFileAtomically(filePath: string, fileContents: string): void {
    ensureParentDirectory(filePath);

    const tempFilePath = join(
        dirname(filePath),
        `${basename(filePath)}.${process.pid}.${Date.now()}.${randomUUID()}.tmp`,
    );
    const fileDescriptor = openSync(tempFilePath, 'w');

    try {
        writeFileSync(fileDescriptor, fileContents, 'utf8');
        fsyncSync(fileDescriptor);
    } finally {
        closeSync(fileDescriptor);
    }

    try {
        renameSync(tempFilePath, filePath);
    } catch (error) {
        try {
            unlinkSync(tempFilePath);
        } catch {
            // Ignore cleanup failures and surface the original rename error.
        }

        throw error;
    }
}
