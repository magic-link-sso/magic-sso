# Dependency patches

These version-specific pnpm patches preserve the current Nuxt/Nitro integration
while replacing dependencies without published security fixes. They are applied
during installation and are included in every Docker dependency stage.

- `nitropack@2.13.4` uses `tinyglobby` instead of `globby`, removing the
  `fast-glob`/`micromatch`/`braces` chain. The replacement covers handler
  scanning, asset discovery, and the Cloudflare preset.
- `listhen@1.10.1` uses `selfsigned` with Node.js cryptography instead of
  `node-forge`. Development certificates retain their CA signature, SANs,
  validity, and encrypted-key support. PFX files are passed directly to Node.js
  TLS, including their passphrase; the returned HTTPS options contain `pfx` for
  that mode. Legacy RC2 keystores use an OpenSSL 3 conversion fallback because
  Node.js disables that algorithm. This optional mode requires `openssl` on
  PATH; the passphrase is passed through the child process environment.
- `@nuxt/devtools@3.4.2` uses the named `simpleGit` export required by the
  patched major version of `simple-git`.

`pnpm-workspace.yaml` removes the original dependencies and declares the
replacements with `packageExtensions`. There are no audit exclusions for these
advisories. When upgrading a patched package, recheck its imports and remove the
patch and corresponding configuration once upstream supplies a compatible fix.

`scripts/dependency-compatibility.test.ts` tests actual installed modules,
including Nitro scanning and public assets, both ESM and CommonJS HTTPS
listeners, encrypted keys, certificate subject escaping, and password-protected
PFX files. Its fixture requires OpenSSL 3 to create temporary modern and legacy
test keystores. Run `pnpm check`, `pnpm run audit`, and `pnpm audit` after
changing these patches.
