import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

const repositoryRoot = process.cwd();

async function readRepositoryFile(relativePath: string): Promise<string> {
    return readFile(join(repositoryRoot, relativePath), 'utf8');
}

describe('release security checks', () => {
    it('documents dependency advisory audits in the release checklist', async () => {
        const checklist = await readRepositoryFile('docs/release-checklist.md');

        expect(checklist).toContain('pnpm run audit');
    });

    it('exposes audit commands from the workspace root package', async () => {
        const packageJson = JSON.parse(await readRepositoryFile('package.json')) as {
            scripts?: Record<string, string>;
        };

        expect(packageJson.scripts?.['audit']).toBe('pnpm run audit:js && pnpm run audit:python');
        expect(packageJson.scripts?.['audit:js']).toBe('pnpm audit -P');
        expect(packageJson.scripts?.['audit:python']).toBe('node scripts/audit-python.mjs');
    });

    it('runs dependency advisory audits before publishing a release', async () => {
        const workflow = await readRepositoryFile('.github/workflows/publish.yml');

        expect(workflow).toContain('run: pnpm run audit');
    });

    it('documents the version bump helper in the release checklist', async () => {
        const checklist = await readRepositoryFile('docs/release-checklist.md');

        expect(checklist).toContain('pnpm changelog:preview');
        expect(checklist).toContain('pnpm release:prepare -- 0.9.0');
        expect(checklist).toContain('git tag v0.9.0 && git push origin v0.9.0');
    });

    it('publishes tagged releases and syncs GitHub release notes from CHANGELOG.md', async () => {
        const workflow = await readRepositoryFile('.github/workflows/publish.yml');

        expect(workflow).toContain('push:');
        expect(workflow).toContain("- 'v*'");
        expect(workflow).toContain('node scripts/verify-release-tag.mjs');
        expect(workflow).toContain('node scripts/extract-release-notes.mjs');
        expect(workflow).toContain('gh release create');
        expect(workflow).toContain('npm view "@magic-link-sso/nextjs@${RELEASE_VERSION}" version');
        expect(workflow).toContain('npm view "@magic-link-sso/nuxt@${RELEASE_VERSION}" version');
        expect(workflow).toContain('npm view "@magic-link-sso/angular@${RELEASE_VERSION}" version');
        expect(workflow).toContain(
            'https://pypi.org/pypi/magic-link-sso-django/${RELEASE_VERSION}/json',
        );
        expect(workflow).toContain("if: steps.nextjs-published.outputs.published != 'true'");
        expect(workflow).toContain("if: steps.django-pypi-published.outputs.published != 'true'");
    });
});
