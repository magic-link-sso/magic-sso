import { describe, expect, it } from 'vitest';

import { buildAuditArgs } from './audit-python.mjs';

describe('audit python script', () => {
    it('uses a hashed requirements export and disables pip resolution', () => {
        const requirementsFile = '/tmp/magic-sso-audit/requirements.txt';
        const { exportArgs, auditArgs } = buildAuditArgs(requirementsFile);

        expect(exportArgs).toContain('--project');
        expect(exportArgs.some((argument) => argument.endsWith('packages/django'))).toBe(true);
        expect(exportArgs).toContain('--no-emit-project');
        expect(exportArgs).toContain('--locked');
        expect(exportArgs).toContain('--format');
        expect(exportArgs).toContain('requirements.txt');
        expect(exportArgs).toContain(requirementsFile);
        expect(auditArgs).toEqual(['pip-audit', '--disable-pip', '-r', requirementsFile]);
    });
});
