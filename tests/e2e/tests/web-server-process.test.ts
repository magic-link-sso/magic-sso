import { describe, expect, it } from 'vitest';
import {
    createWebServerSpawnOptions,
    getWebServerProcessSignalTarget,
} from '../src/web-server-process.mjs';

describe('createWebServerSpawnOptions', () => {
    it('uses the platform shell instead of requiring zsh', () => {
        const env = { PATH: '/tmp/bin' };

        expect(
            createWebServerSpawnOptions({
                cwd: '/tmp/magic-sso',
                env,
            }),
        ).toEqual({
            cwd: '/tmp/magic-sso',
            detached: process.platform !== 'win32',
            env,
            shell: true,
            stdio: ['ignore', 'pipe', 'pipe'],
        });
    });

    it('signals the complete process group outside Windows', () => {
        expect(getWebServerProcessSignalTarget(1234, 'linux')).toBe(-1234);
        expect(getWebServerProcessSignalTarget(1234, 'darwin')).toBe(-1234);
    });

    it('signals the direct child on Windows', () => {
        expect(getWebServerProcessSignalTarget(1234, 'win32')).toBe(1234);
    });
});
