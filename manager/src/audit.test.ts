// SPDX-License-Identifier: GPL-3.0-or-later

import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { afterEach, describe, expect, it } from 'vitest';
import { appendManagerAuditEvent, loadManagerAuditEvents } from './audit.js';
import { type ManagerAuditEvent } from './apply.js';
import { type ManagerRuntimeSettings } from './settings.js';

const tempDirectories: string[] = [];

function createTempDirectory(prefix: string): string {
    const tempDirectory = mkdtempSync(join(tmpdir(), prefix));
    tempDirectories.push(tempDirectory);
    return tempDirectory;
}

function createSettings(
    tempDirectory: string,
    auditOverrides: Partial<NonNullable<ManagerRuntimeSettings['audit']>> = {},
): ManagerRuntimeSettings {
    return {
        audit: {
            integrityKey: 'manager-audit-integrity-key-0123456789abcdefghij',
            maxArchivedFiles: 2,
            maxFileBytes: 512,
            ...auditOverrides,
        },
        configFilePath: join(tempDirectory, 'manager', 'manager.toml'),
        managedSiteIds: ['client'],
        paths: {
            auditFile: join(tempDirectory, 'manager-audit.ndjson'),
            baseConfigFile: join(tempDirectory, 'magic-sso.base.toml'),
            lastGoodRuntimeConfigFile: join(tempDirectory, 'magic-sso.runtime.last-good.toml'),
            lockFile: join(tempDirectory, 'manager.lock'),
            runtimeConfigFile: join(tempDirectory, 'magic-sso.runtime.toml'),
            stateFile: join(tempDirectory, 'manager-state.json'),
        },
    };
}

function createAuditEvent(
    id: string,
    timestamp: string,
    message = `event-${id}`,
): ManagerAuditEvent {
    return {
        actor: {
            host: 'host-1',
            siteId: 'manager-admin',
            user: 'operator-1',
        },
        baseConfigHash: `base-${id}`,
        changedSiteIds: ['client'],
        id,
        kind: 'grant-saved',
        message,
        reloaded: false,
        rolledBack: false,
        runtimeConfigHash: `runtime-${id}`,
        stateHash: `state-${id}`,
        timestamp,
    };
}

afterEach(() => {
    for (const directory of tempDirectories) {
        rmSync(directory, { force: true, recursive: true });
    }
    tempDirectories.length = 0;
});

describe('manager audit loading', () => {
    it('returns newest-first signed events and respects a limit', () => {
        const tempDirectory = createTempDirectory('magic-sso-manager-audit-');
        const settings = createSettings(tempDirectory);

        expect(
            appendManagerAuditEvent(
                settings,
                createAuditEvent('evt-1', '2026-05-02T10:00:00.000Z'),
            ),
        ).toBe(true);
        expect(
            appendManagerAuditEvent(
                settings,
                createAuditEvent('evt-2', '2026-05-02T10:05:00.000Z'),
            ),
        ).toBe(true);

        expect(loadManagerAuditEvents(settings)).toMatchObject([
            {
                id: 'evt-2',
            },
            {
                id: 'evt-1',
            },
        ]);
        expect(loadManagerAuditEvents(settings, 1)).toMatchObject([
            {
                id: 'evt-2',
            },
        ]);
    });

    it('rotates bounded audit files and still loads archived entries', () => {
        const tempDirectory = createTempDirectory('magic-sso-manager-audit-rotation-');
        const settings = createSettings(tempDirectory, {
            maxArchivedFiles: 2,
            maxFileBytes: 350,
        });

        for (let index = 0; index < 5; index += 1) {
            expect(
                appendManagerAuditEvent(
                    settings,
                    createAuditEvent(
                        `evt-${index + 1}`,
                        `2026-05-02T10:0${index}:00.000Z`,
                        `rotation-event-${index + 1}-${'x'.repeat(48)}`,
                    ),
                ),
            ).toBe(true);
        }

        expect(readFileSync(settings.paths.auditFile, 'utf8')).toContain('"evt-5"');
        expect(readFileSync(`${settings.paths.auditFile}.1`, 'utf8')).toContain('"evt-4"');
        expect(readFileSync(`${settings.paths.auditFile}.2`, 'utf8')).toContain('"evt-3"');
        expect(loadManagerAuditEvents(settings).map((event) => event.id)).toEqual([
            'evt-5',
            'evt-4',
            'evt-3',
        ]);
    });

    it('returns an empty list when no audit files are present', () => {
        const tempDirectory = createTempDirectory('magic-sso-manager-audit-empty-');

        expect(loadManagerAuditEvents(createSettings(tempDirectory))).toEqual([]);
    });

    it('rejects tampered signed audit file contents', () => {
        const tempDirectory = createTempDirectory('magic-sso-manager-audit-tampered-');
        const settings = createSettings(tempDirectory);
        expect(
            appendManagerAuditEvent(
                settings,
                createAuditEvent('evt-1', '2026-05-02T10:00:00.000Z'),
            ),
        ).toBe(true);

        writeFileSync(
            settings.paths.auditFile,
            readFileSync(settings.paths.auditFile, 'utf8').replace(
                'event-evt-1',
                'tampered-message',
            ),
            'utf8',
        );

        expect(() => loadManagerAuditEvents(settings)).toThrowError(
            /integrity verification failed/i,
        );
    });

    it('rejects invalid audit file contents', () => {
        const tempDirectory = createTempDirectory('magic-sso-manager-audit-invalid-');
        const settings = createSettings(tempDirectory);
        writeFileSync(settings.paths.auditFile, '{"not":"an event"}\n', 'utf8');

        expect(() => loadManagerAuditEvents(settings)).toThrowError(
            /Invalid input|Required|expected/i,
        );
    });
});
