import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

type PackageJson = Readonly<{
    scripts?: Readonly<Record<string, string>>;
}>;

function isPackageJson(value: unknown): value is PackageJson {
    return typeof value === 'object' && value !== null;
}

async function readPackageJson(relativePath: string): Promise<PackageJson> {
    const absolutePath = join(process.cwd(), relativePath);
    const contents = await readFile(absolutePath, 'utf8');
    const parsed: unknown = JSON.parse(contents);

    if (!isPackageJson(parsed)) {
        throw new Error(`${relativePath} did not parse into a package.json object`);
    }

    return parsed;
}

describe('workspace build scripts', () => {
    it('runs build and typecheck as separate root check phases', async () => {
        const packageJson = await readPackageJson('package.json');

        expect(packageJson.scripts?.check).toBe(
            'turbo run lint format:check build && turbo run typecheck && pnpm run test && pnpm run python:check',
        );
    });

    it('keeps shared package builds concurrency-safe', async () => {
        const packagePaths = [
            'packages/angular/package.json',
            'packages/nextjs/package.json',
            'packages/nuxt/package.json',
        ];

        for (const packagePath of packagePaths) {
            const packageJson = await readPackageJson(packagePath);

            expect(
                packageJson.scripts?.build,
                `${packagePath} should not delete dist during build`,
            ).toBe('tsc -p tsconfig.json');
            expect(packageJson.scripts?.clean).toBe('rm -rf dist tsconfig.tsbuildinfo');
        }
    });
});
