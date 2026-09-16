import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const scriptDirectory = dirname(fileURLToPath(import.meta.url));
const repositoryRoot = resolve(scriptDirectory, '..');

/**
 * Workspaces whose Vitest suites contribute to the merged coverage report.
 * `examples/nextjs` runs `node --test` and `examples/django` is Python, so
 * neither produces Istanbul data.
 */
export const COVERAGE_WORKSPACES = [
    'examples/angular',
    'examples/fastify',
    'examples/gate-private1-app',
    'examples/gate-private2-static',
    'examples/nuxt',
    'examples/photos',
    'gate',
    'manager',
    'packages/angular',
    'packages/config-core',
    'packages/core',
    'packages/example-ui',
    'packages/nextjs',
    'packages/nuxt',
    'server',
    'tests/e2e',
];

export const ROOT_COVERAGE_DIRECTORY = 'coverage/scripts';
export const MERGED_COVERAGE_FILE = 'coverage/coverage-final.json';

/**
 * Vitest's v8 provider remaps to an Istanbul coverage map, so the `json`
 * reporter writes a `coverage-final.json` that fallow can consume directly.
 * Test files are excluded by Vitest automatically.
 */
export const VITEST_COVERAGE_ARGS = [
    '--coverage.enabled',
    '--coverage.provider=v8',
    '--coverage.reporter=json',
];

/**
 * @typedef {Record<string, number>} HitMap
 * @typedef {{ s: HitMap; f: HitMap; b: Record<string, number[]> } & Record<string, unknown>} FileCoverage
 * @typedef {Record<string, FileCoverage>} CoverageMap
 */

/**
 * @param {HitMap} target
 * @param {HitMap} source
 * @returns {HitMap}
 */
function addHits(target, source) {
    const merged = { ...target };
    for (const [key, count] of Object.entries(source)) {
        merged[key] = (merged[key] ?? 0) + count;
    }
    return merged;
}

/**
 * @param {Record<string, number[]>} target
 * @param {Record<string, number[]>} source
 * @returns {Record<string, number[]>}
 */
function addBranchHits(target, source) {
    const merged = { ...target };
    for (const [key, counts] of Object.entries(source)) {
        const existing = merged[key] ?? [];
        merged[key] = counts.map((count, index) => count + (existing[index] ?? 0));
    }
    return merged;
}

/**
 * Merges Istanbul coverage maps, summing hit counts for files that appear in
 * more than one map.
 *
 * @param {CoverageMap[]} coverageMaps
 * @returns {CoverageMap}
 */
export function mergeCoverageMaps(coverageMaps) {
    /** @type {CoverageMap} */
    const merged = {};
    for (const coverageMap of coverageMaps) {
        for (const [filePath, fileCoverage] of Object.entries(coverageMap)) {
            const existing = merged[filePath];
            merged[filePath] = existing
                ? {
                      ...existing,
                      s: addHits(existing.s, fileCoverage.s),
                      f: addHits(existing.f, fileCoverage.f),
                      b: addBranchHits(existing.b, fileCoverage.b),
                  }
                : fileCoverage;
        }
    }
    return merged;
}

/**
 * @param {string} root
 * @returns {string[]}
 */
export function listCoverageReports(root) {
    return [
        ROOT_COVERAGE_DIRECTORY,
        ...COVERAGE_WORKSPACES.map((workspace) => join(workspace, 'coverage')),
    ].map((directory) => join(root, directory, 'coverage-final.json'));
}

/**
 * @param {string} command
 * @param {string[]} args
 * @param {string} cwd
 */
function run(command, args, cwd) {
    const result = spawnSync(command, args, { cwd, stdio: 'inherit' });
    if (result.status !== 0) {
        throw new Error(`${command} ${args.join(' ')} failed with status ${result.status}`);
    }
}

/**
 * @param {string} root
 * @returns {void}
 */
export function runCoverage(root = repositoryRoot) {
    const reports = listCoverageReports(root);
    for (const report of reports) {
        rmSync(report, { force: true });
    }

    run(
        'pnpm',
        [
            'exec',
            'vitest',
            'run',
            'scripts/',
            ...VITEST_COVERAGE_ARGS,
            '--coverage.include=scripts/*.mjs',
            `--coverage.reportsDirectory=${ROOT_COVERAGE_DIRECTORY}`,
        ],
        root,
    );
    run(
        'pnpm',
        [
            'exec',
            'turbo',
            'run',
            'test',
            '--force',
            ...COVERAGE_WORKSPACES.map((workspace) => `--filter=./${workspace}`),
            '--',
            ...VITEST_COVERAGE_ARGS,
        ],
        root,
    );

    const coverageMaps = reports
        .filter((report) => existsSync(report))
        .map((report) => JSON.parse(readFileSync(report, 'utf8')));
    const outputFile = join(root, MERGED_COVERAGE_FILE);
    mkdirSync(dirname(outputFile), { recursive: true });
    writeFileSync(outputFile, JSON.stringify(mergeCoverageMaps(coverageMaps)));
    console.log(`Merged ${coverageMaps.length} coverage reports into ${MERGED_COVERAGE_FILE}`);
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
    runCoverage();
}
