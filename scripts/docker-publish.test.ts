import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

const repositoryRoot = process.cwd();

async function readRepositoryFile(relativePath: string): Promise<string> {
    return readFile(join(repositoryRoot, relativePath), 'utf8');
}

describe('docker publish workflow', () => {
    it('publishes server, gate, and manager images', async () => {
        const workflow = await readRepositoryFile('.github/workflows/docker-publish.yml');

        expect(workflow).toContain('dockerfile: ./server/Dockerfile');
        expect(workflow).toContain('image_name: server');
        expect(workflow).toContain('dockerfile: ./gate/Dockerfile');
        expect(workflow).toContain('image_name: gate');
        expect(workflow).toContain('dockerfile: ./manager/Dockerfile');
        expect(workflow).toContain('image_name: manager');
    });

    it('attests the full published image path for each component', async () => {
        const workflow = await readRepositoryFile('.github/workflows/docker-publish.yml');

        expect(workflow).toContain(
            'subject-name: ${{ env.REGISTRY }}/${{ env.IMAGE_NAMESPACE }}/${{ matrix.image_name }}',
        );
    });

    it('installs workspace dependencies when building published images', async () => {
        const [serverDockerfile, gateDockerfile, managerDockerfile] = await Promise.all([
            readRepositoryFile('server/Dockerfile'),
            readRepositoryFile('gate/Dockerfile'),
            readRepositoryFile('manager/Dockerfile'),
        ]);

        expect(serverDockerfile).toContain(
            'pnpm install --ignore-scripts --filter magic-sso-server... --frozen-lockfile',
        );
        expect(serverDockerfile).toContain(
            'pnpm install --ignore-scripts --filter magic-sso-server... --prod --frozen-lockfile',
        );
        expect(gateDockerfile).toContain(
            'pnpm install --ignore-scripts --filter magic-sso-gate... --frozen-lockfile',
        );
        expect(gateDockerfile).toContain(
            'pnpm install --ignore-scripts --filter magic-sso-gate... --prod --frozen-lockfile',
        );
        expect(managerDockerfile).toContain(
            'pnpm install --ignore-scripts --filter magic-sso-manager... --frozen-lockfile',
        );
        expect(managerDockerfile).toContain(
            'pnpm install --ignore-scripts --filter magic-sso-manager... --prod --frozen-lockfile',
        );
    });
});
