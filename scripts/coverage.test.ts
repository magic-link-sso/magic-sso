import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { COVERAGE_WORKSPACES, listCoverageReports, mergeCoverageMaps } from './coverage.mjs';

describe('coverage merge', () => {
    it('keeps files that appear in a single report', () => {
        const fileCoverage = { path: '/repo/a.ts', s: { 0: 1 }, f: { 0: 1 }, b: { 0: [1, 0] } };

        expect(mergeCoverageMaps([{ '/repo/a.ts': fileCoverage }, {}])).toEqual({
            '/repo/a.ts': fileCoverage,
        });
    });

    it('sums statement, function, and branch hits for shared files', () => {
        const merged = mergeCoverageMaps([
            {
                '/repo/a.ts': {
                    path: '/repo/a.ts',
                    s: { 0: 1, 1: 0 },
                    f: { 0: 0 },
                    b: { 0: [1, 0] },
                },
            },
            {
                '/repo/a.ts': {
                    path: '/repo/a.ts',
                    s: { 0: 2, 1: 3 },
                    f: { 0: 1 },
                    b: { 0: [0, 4] },
                },
            },
        ]);

        expect(merged['/repo/a.ts']).toEqual({
            path: '/repo/a.ts',
            s: { 0: 3, 1: 3 },
            f: { 0: 1 },
            b: { 0: [1, 4] },
        });
    });

    it('lists the root scripts report and one report per workspace', () => {
        const reports = listCoverageReports('/repo');

        expect(reports[0]).toBe(join('/repo', 'coverage/scripts', 'coverage-final.json'));
        expect(reports).toHaveLength(COVERAGE_WORKSPACES.length + 1);
        expect(reports).toContain(join('/repo', 'server', 'coverage', 'coverage-final.json'));
    });
});
