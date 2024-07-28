import { describe, expect, it } from 'vitest';
import { createWebServerSpawnOptions } from '../src/web-server-process.mjs';

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
            env,
            shell: true,
            stdio: ['ignore', 'pipe', 'pipe'],
        });
    });
});
