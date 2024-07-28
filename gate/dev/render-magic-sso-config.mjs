import { readFileSync, writeFileSync } from 'node:fs';

const templatePath = '/app/server/magic-sso.toml.template';
const outputPath = '/app/server/magic-sso.toml';

const template = readFileSync(templatePath, 'utf8');

const rendered = template.replaceAll(/\$\{([A-Z0-9_]+)\}/g, (_match, key) => {
    const value = process.env[key];

    if (typeof value !== 'string' || value.length === 0) {
        throw new Error(`Missing required env var for Magic Link SSO dev config: ${key}`);
    }

    return value;
});

writeFileSync(outputPath, rendered, 'utf8');
