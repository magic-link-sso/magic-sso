import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { createPrivateKey, X509Certificate } from 'node:crypto';
import { mkdtemp, mkdir, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { get } from 'node:https';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { promisify } from 'node:util';

const nitroPackage = await realpath('packages/nuxt/node_modules/nitropack/package.json');
const fromNitro = createRequire(nitroPackage);
const { createNitro, scanHandlers, copyPublicAssets } = await import(
    pathToFileURL(join(dirname(nitroPackage), 'dist/core/index.mjs')).href
);
const listhenPath = fromNitro.resolve('listhen');
const fromListhen = createRequire(listhenPath);
assert.throws(() => fromNitro.resolve('globby'), { code: 'MODULE_NOT_FOUND' });
assert.throws(() => fromListhen.resolve('node-forge'), { code: 'MODULE_NOT_FOUND' });
const root = await mkdtemp(join(tmpdir(), 'magic-sso-dependencies-'));
const run = promisify(execFile);

async function put(relative, content = '') {
    const file = join(root, relative);
    await mkdir(dirname(file), { recursive: true });
    await writeFile(file, content);
    return file;
}

async function request(listener) {
    return await new Promise((resolve, reject) => {
        // A generated development certificate is deliberately outside the system trust store.
        const req = get(listener.url, { rejectUnauthorized: false, agent: false }, (res) => {
            let body = '';
            res.setEncoding('utf8');
            res.on('data', (chunk) => {
                body += chunk;
            });
            res.on('end', () => resolve(body));
            res.on('error', reject);
        });
        req.on('error', reject);
    });
}

const listenOptions = {
    hostname: '127.0.0.1',
    port: 0,
    isTest: true,
    autoClose: false,
    showURL: false,
};
const handler = (_req, res) => res.end('Magic Link SSO');

try {
    await put('api/users/[id].get.ts');
    await put('api/.hidden.mjs');
    await put('api/ignored.ts');
    await put('api/readme.md');
    await put('routes/index.cts');
    await put('public/.well-known/hello.txt', 'asset');
    const nitro = await createNitro({
        rootDir: root,
        srcDir: '.',
        scanDirs: [root],
        ignore: ['**/ignored.ts'],
        preset: 'node-server',
        logLevel: 0,
    });
    try {
        const handlers = await scanHandlers(nitro);
        assert.deepEqual(handlers.map(({ route }) => route).sort(), [
            '/',
            '/api/.hidden',
            '/api/users/:id',
        ]);
        assert.equal(handlers.find(({ route }) => route === '/api/users/:id').method, 'get');
        assert.ok(handlers.every(({ handler: file }) => file.startsWith(root)));
        await copyPublicAssets(nitro);
        assert.equal(
            await readFile(join(nitro.options.output.publicDir, '.well-known/hello.txt'), 'utf8'),
            'asset',
        );
    } finally {
        await nitro.close();
    }

    const esmPath = join(dirname(listhenPath), 'index.mjs');
    const modules = [await import(pathToFileURL(esmPath).href), fromListhen(listhenPath)];
    for (const { listen } of modules) {
        const defaultListener = await listen(handler, { ...listenOptions, https: true });
        try {
            assert.equal(await request(defaultListener), 'Magic Link SSO');
        } finally {
            await defaultListener.close();
        }
        const generated = await listen(handler, {
            ...listenOptions,
            https: {
                domains: ['localhost', '127.0.0.1', '::1'],
                passphrase: 'leaf-password',
                signingKeyPassphrase: 'ca-password',
                organization: 'Testing, Inc + R&D',
                emailAddress: 'developer@example.com',
            },
        });
        try {
            const certificate = new X509Certificate(generated.https.cert);
            assert.equal(certificate.toLegacyObject().subject.O, 'Testing, Inc + R&D');
            assert.equal(
                certificate.toLegacyObject().subject.emailAddress,
                'developer@example.com',
            );
            assert.equal(certificate.checkHost('localhost'), 'localhost');
            assert.equal(certificate.checkIP('127.0.0.1'), '127.0.0.1');
            assert.equal(certificate.checkIP('::1'), '::1');
            assert.equal(
                certificate.checkPrivateKey(
                    createPrivateKey({ key: generated.https.key, passphrase: 'leaf-password' }),
                ),
                true,
            );
            assert.ok(Date.parse(certificate.validTo) > Date.now());
            assert.equal(await request(generated), 'Magic Link SSO');
            const keyFile = await put(
                'leaf.key',
                createPrivateKey({ key: generated.https.key, passphrase: 'leaf-password' }).export({
                    type: 'pkcs8',
                    format: 'pem',
                }),
            );
            const certFile = await put('leaf.pem', generated.https.cert);
            const pfxFile = join(root, 'leaf.pfx');
            await run('openssl', [
                'pkcs12',
                '-export',
                '-inkey',
                keyFile,
                '-in',
                certFile,
                '-out',
                pfxFile,
                '-passin',
                'pass:leaf-password',
                '-passout',
                'pass:pfx-password',
            ]);
            const pfxListener = await listen(handler, {
                ...listenOptions,
                https: { pfx: pfxFile, passphrase: 'pfx-password' },
            });
            try {
                assert.equal(await request(pfxListener), 'Magic Link SSO');
            } finally {
                await pfxListener.close();
            }
            await assert.rejects(
                listen(handler, {
                    ...listenOptions,
                    https: { pfx: pfxFile, passphrase: 'wrong-password' },
                }),
            );
            const legacyPfxFile = join(root, 'legacy.pfx');
            await run('openssl', [
                'pkcs12',
                '-export',
                '-legacy',
                '-inkey',
                keyFile,
                '-in',
                certFile,
                '-out',
                legacyPfxFile,
                '-passout',
                'pass:pfx-password',
            ]);
            const legacyListener = await listen(handler, {
                ...listenOptions,
                https: { pfx: legacyPfxFile, passphrase: 'pfx-password' },
            });
            try {
                assert.equal(await request(legacyListener), 'Magic Link SSO');
            } finally {
                await legacyListener.close();
            }
            await assert.rejects(
                listen(handler, {
                    ...listenOptions,
                    https: { pfx: legacyPfxFile, passphrase: 'wrong-password' },
                }),
            );
        } finally {
            await generated.close();
        }
    }
} finally {
    await rm(root, { recursive: true, force: true });
}
