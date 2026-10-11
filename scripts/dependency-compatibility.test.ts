import { readFile, realpath } from 'node:fs/promises';
import { execFile } from 'node:child_process';
import { createRequire } from 'node:module';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { promisify } from 'node:util';
import { describe, expect, it } from 'vitest';

describe('dependency compatibility', () => {
    it('preserves Nitro scanning and HTTPS with the replacement dependencies', async () => {
        const fixture = 'scripts/fixtures/nitro-dependencies.mjs';
        const fallowConfig: unknown = JSON.parse(
            await readFile(join(process.cwd(), '.fallowrc.json'), 'utf8'),
        );
        expect(fallowConfig).toMatchObject({
            dynamicallyLoaded: expect.arrayContaining([fixture]),
        });
        const run = promisify(execFile);
        await run(process.execPath, [fixture], {
            timeout: 30_000,
        });
    }, 35_000);

    it.each([
        'server/Dockerfile',
        'gate/Dockerfile',
        'manager/Dockerfile',
        'examples/gate-private1-app/Dockerfile',
        'examples/photos/Dockerfile',
    ])('includes dependency patches before every install in %s', async (file) => {
        const dockerfile = await readFile(join(process.cwd(), file), 'utf8');
        const dockerignore = await readFile(join(process.cwd(), '.dockerignore'), 'utf8');

        expect(dockerignore.split('\n')).toContain('!patches/');
        for (const stage of dockerfile.split(/^FROM /m)) {
            if (stage.includes('RUN pnpm install')) {
                expect(stage.indexOf('COPY patches patches')).toBeGreaterThanOrEqual(0);
                expect(stage.indexOf('COPY patches patches')).toBeLessThan(
                    stage.indexOf('RUN pnpm install'),
                );
            }
        }
    });

    it('loads Nuxt DevTools with the patched simple-git import', async () => {
        const nuxtPackage = await realpath(
            join(process.cwd(), 'examples/nuxt/node_modules/nuxt/package.json'),
        );
        const requireFromNuxt = createRequire(nuxtPackage);
        const devtoolsModule = requireFromNuxt.resolve(
            '@nuxt/devtools/dist/chunks/module-main.mjs',
        );

        await expect(import(pathToFileURL(devtoolsModule).href)).resolves.toBeDefined();
    });
});
