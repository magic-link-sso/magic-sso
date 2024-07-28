# Local Dev Integration with External Projects

Before publishing Magic SSO packages publicly, it is useful to test them from a
separate app exactly like a real consumer would. The recommended setup depends
on whether the external app is Python/Django or JavaScript.

## Shared local setup

No matter which client package you are testing:

1. Run the local Magic SSO server from this repo.
2. Add the external app's localhost origin to `server/magic-sso.toml`.
3. Point the external app at the local server with its normal `MAGICSSO_*`
   settings.

For example, if your external app runs on `http://localhost:3005`, add that
origin to the relevant `[[sites]]` entry before testing sign-in end to end.

## A. Django or other Python app with `uv`

For Python, the closest equivalent to `npm link` is usually an editable local
path dependency. This is the best option while you are actively changing
`magic-link-sso-django`.

Example `pyproject.toml` in the external project:

```toml
[project]
dependencies = ["magic-link-sso-django"]

[tool.uv.sources]
magic-link-sso-django = { path = "../magic-sso/packages/django", editable = true }
```

Then sync the environment:

```sh
uv sync
```

That makes the external project import the package directly from your local
checkout, so changes inside `packages/django/` are visible immediately.

This repo already uses that pattern in
[`examples/django/pyproject.toml`](../examples/django/pyproject.toml).

If you want a more release-like smoke test before publishing, keep the local
path source but remove `editable = true`, then run `uv sync` again. That checks
that the package still installs cleanly when treated like a normal dependency.

## B. JavaScript projects

For the JS packages (`@magic-link-sso/nextjs`, `@magic-link-sso/angular`,
`@magic-link-sso/nuxt`), there are three useful local-testing options.

### 1. Fastest local iteration: local path dependency

This is usually simpler than a global link because it is recorded in the
consumer app's `package.json` and lockfile.

```json
{
    "dependencies": {
        "@magic-link-sso/nextjs": "file:../magic-sso/packages/nextjs"
    }
}
```

Then install in the external project with its normal package manager.

Important: the JS packages in this repo publish built files from `dist/`, so you
should keep a build running while developing them locally:

```sh
pnpm --filter @magic-link-sso/nextjs build:watch
```

Use the matching package name and folder for Angular or Nuxt.

### 2. Classic link workflow: `npm link`

If you prefer a true link-style workflow:

```sh
cd packages/nextjs
npm link
```

Then in the external project:

```sh
npm link @magic-link-sso/nextjs
```

This works well for quick experiments, but it is a little less explicit than a
`file:` dependency and easier to forget about later.

### 3. Best pre-publish check: `npm pack`

`npm pack` is the closest test to what users will actually install from the
registry.

From this repo:

```sh
cd packages/nextjs
pnpm build
npm pack
```

That produces a tarball such as `@magic-link-sso/nextjs-x.y.z.tgz`. Install that
tarball into the external project:

```sh
npm install ../magic-sso/packages/nextjs/@magic-link-sso/nextjs-x.y.z.tgz
```

This is the best final smoke test before publishing because it validates the
actual packaged contents, not just your local source tree.

## Recommended workflow

- Django / Python: use a `uv` local path source with `editable = true`.
- JS during active development: use a local path dependency or `npm link`, and
  keep the package build watcher running.
- JS before publishing: run `npm pack` and install the tarball into the other
  project.

That gives you both fast iteration and a realistic final package test.
