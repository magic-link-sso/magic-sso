# SSR Photos Demo with Magic Link SSO

[Magic Link SSO](../../README.md)

This is the managed-mode SSR photo-sharing demo for Magic Link SSO. It shows:

- public albums and photos for anonymous visitors
- members-only albums unlocked with Magic Link SSO
- manager-controlled access grants for `friends`, `family`, and one
  photo-specific scope
- a read-only app so the demo stays focused on access behavior rather than CRUD

## Getting Started

Install workspace dependencies from the repository root:

```bash
pnpm install
```

The first `pnpm dev`, `pnpm build`, or `pnpm start` run fills in missing
defaults in `.env.local` from [`.env.local.example`](./.env.local.example).
`MAGICSSO_PUBLIC_ORIGIN` defaults to `http://localhost:5001`, which is also the
canonical managed-mode Photos origin used by the local manager flow and the
manager Docker stack. See
[packages/nextjs/README.md](../../packages/nextjs/README.md) for the Next.js
package environment details.

Then run the Photos demo from the repository root:

```bash
pnpm dev:photos
```

Open [http://localhost:5001](http://localhost:5001).

For the easiest managed-mode demo, start the full repository stack instead:

```bash
pnpm dev:manager:stack
```

That brings up the SSR Photos demo alongside the manager UI, Magic Link SSO
Gate, and the supporting services used by the managed-mode flow.

## Managed-Mode Demo Flow

The intended demo flow is:

1. Browse public albums anonymously.
2. Open a restricted album or the `Red Kite at Dusk` photo.
3. Use the Manager UI to grant an email `friends`, `family`, or
   `photo:red-kite-at-dusk`.
4. Request a Magic Link SSO email for that exact scope and verify that the SSR
   page changes immediately after sign-in.
