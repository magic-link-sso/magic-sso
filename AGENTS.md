# AGENTS.md

## Naming

- Use `Magic Link SSO` in user-facing copy, docs, page titles, and screenshots.
- Keep existing machine-facing identifiers such as `magic-sso`,
  `@magic-link-sso/angular`, `@magic-link-sso/nextjs`, `@magic-link-sso/nuxt`,
  `magic-link-sso-django`, `magic_sso_django`, and `MAGICSSO_*` for package
  names, import paths, env vars, and repository slugs.

## Language & Types

- **TypeScript** — strict mode mandatory (`"strict": true`). No `any`, no type
  assertions without a comment justifying them. All exported functions must have
  explicit return types.
- **Python** — type hints required on all function signatures and class
  attributes. Run `ty` (or `mypy`) before committing; no untyped code.

## Tests

- Write tests for every new feature and bug fix — no exceptions.
- **JS/TS**: use Vitest (or `supertest` for server routes). Place tests
  alongside source as `*.test.ts`.
- **Python**: use `pytest`. Place tests in `tests/` within the package.

## Formatting & Linting

Run before every commit — CI will reject unformatted or linted code:

```sh
pnpm check
```

## Commit hygiene

- Use the [Conventional Commits](https://www.conventionalcommits.org/) spec for
  all commit messages (`feat:`, `fix:`, `chore:`, `docs:`, etc.).
- **Never commit automatically** — only commit when the user explicitly asks for
  it.
- Commit only working, formatted, linted code.
- Keep commits focused; one logical change per commit.
- Never commit secrets, `.env` files, or auto-generated `dist/` artefacts.
