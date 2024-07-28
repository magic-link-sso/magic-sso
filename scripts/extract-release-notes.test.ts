import { describe, expect, it } from 'vitest';
import { extractReleaseNotes, normalizeReleaseIdentifier } from './extract-release-notes.mjs';

const changelog = `# Changelog

## [0.9.0] - 2026-04-25

### Added
- Release automation

## [0.8.0] - 2026-04-01

### Fixed
- Previous release
`;

describe('release note extraction', () => {
    it('accepts a bare version or a version tag', () => {
        expect(normalizeReleaseIdentifier('0.9.0')).toBe('0.9.0');
        expect(normalizeReleaseIdentifier('v0.9.0')).toBe('0.9.0');
    });

    it('extracts a single release section from CHANGELOG.md', () => {
        expect(extractReleaseNotes(changelog, 'v0.9.0')).toBe(`## [0.9.0] - 2026-04-25

### Added
- Release automation
`);
    });
});
