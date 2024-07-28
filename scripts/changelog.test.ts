import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import {
    buildGitCliffArgs,
    insertReleaseSection,
    normalizeRenderedSection,
    parseCliArgs,
} from './changelog.mjs';

describe('changelog CLI', () => {
    it('parses preview and release command lines', () => {
        expect(parseCliArgs(['preview'])).toEqual({ command: 'preview' });
        expect(parseCliArgs(['release', 'minor'])).toEqual({
            command: 'release',
            versionSpecifier: 'minor',
        });
        expect(parseCliArgs(['--', 'release', '0.9.0'])).toEqual({
            command: 'release',
            versionSpecifier: '0.9.0',
        });
    });

    it('builds git-cliff arguments for preview and release flows', () => {
        expect(buildGitCliffArgs({})).toEqual([
            'exec',
            'git-cliff',
            '--config',
            'cliff.toml',
            '--unreleased',
            '--strip',
            'header',
            '--no-exec',
            '--offline',
        ]);
        expect(buildGitCliffArgs({ version: '0.9.0' })).toEqual([
            'exec',
            'git-cliff',
            '--config',
            'cliff.toml',
            '--unreleased',
            '--strip',
            'header',
            '--no-exec',
            '--offline',
            '--tag',
            '0.9.0',
        ]);
    });

    it('uses whitespace control in the git-cliff template to avoid extra blank lines', async () => {
        const config = await readFile(path.join(process.cwd(), 'cliff.toml'), 'utf8');

        expect(config).toContain('{% if version -%}');
        expect(config).not.toContain('## [Unreleased]');
        expect(config).toContain('{% macro print_commit(commit) -%}');
        expect(config).toContain(
            '{% for group, commits in commits | group_by(attribute="group") %}',
        );
        expect(config).toContain('{% for commit in commits -%}');
        expect(config).toContain('- {% if commit.scope %}({{ commit.scope }}) {% endif %}\\');
        expect(config).toContain('{{ self::print_commit(commit=commit) }}');
    });
});

describe('changelog updates', () => {
    it('normalizes git-cliff output before writing it into CHANGELOG.md', () => {
        expect(
            normalizeRenderedSection('\n## [0.9.0] - 2026-04-25\n\n### Added\n- Feature\n\n'),
        ).toBe('## [0.9.0] - 2026-04-25\n\n### Added\n- Feature\n');
    });

    it('prepends a release section before older release entries', () => {
        const changelog = `# Changelog

## [0.8.0] - 2026-04-01

### Fixed
- Existing fix
`;
        const next = insertReleaseSection(
            changelog,
            '\n## [0.9.0] - 2026-04-25\n\n### Added\n- New feature\n',
            '0.9.0',
        );

        expect(next).toBe(`# Changelog

## [0.9.0] - 2026-04-25

### Added
- New feature

## [0.8.0] - 2026-04-01

### Fixed
- Existing fix
`);
    });

    it('supports release sections with no releasable commits', () => {
        const changelog = `# Changelog
`;

        expect(insertReleaseSection(changelog, '\n## [0.9.0] - 2026-04-25\n', '0.9.0')).toBe(
            `# Changelog

## [0.9.0] - 2026-04-25
`,
        );
    });
});
