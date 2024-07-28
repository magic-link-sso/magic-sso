import { readFileSync, writeFileSync } from 'node:fs';

const templatePath = '/app/gate/magic-gate.toml.template';
const outputPath = '/app/gate/magic-gate.toml';

const template = readFileSync(templatePath, 'utf8');

const rendered = template.replaceAll(/\$\{([A-Z0-9_]+)\}/g, (_match, key) => {
    const value = process.env[key];

    if (typeof value !== 'string' || value.length === 0) {
        throw new Error(`Missing required env var for Magic Link SSO Gate dev config: ${key}`);
    }

    return value;
});

writeFileSync(outputPath, rendered, 'utf8');
