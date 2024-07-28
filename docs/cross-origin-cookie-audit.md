# Cross-Origin Cookies

Magic Link SSO works best when the final authentication cookie is set on the
application's own origin.

For deployments that span different origins or unrelated domains, the
recommended pattern is an app-owned `/verify-email` callback. In that flow, the
application receives the email link, exchanges the token with Magic Link SSO,
and sets the session cookie itself. This keeps the resulting session first-party
and avoids relying on cross-site cookie behavior that browsers are increasingly
restricting.

The built-in hosted `/verify-email` flow is still appropriate when the
application and Magic Link SSO can share cookie scope, such as same-site or
shared-cookie-domain deployments. It should not be the default recommendation
for unrelated domains.

## Recommended Approach

- For cross-origin deployments, prefer an app-owned `/verify-email` callback
  that exchanges the token with Magic Link SSO and sets the final auth cookie on
  the application origin.
- Use the built-in hosted `/verify-email` flow when the server-set cookie
  remains first-party to the destination app or is otherwise readable by that
  app.
- Do not rely on `SameSite=None` as a durable strategy for shared auth cookies
  across unrelated domains.
- Do not treat CHIPS or the Storage Access API as the primary solution for Magic
  Link SSO's email-link handoff.

## Why This Is The Recommended Pattern

Modern browsers increasingly restrict third-party cookies and partition cookie
storage by top-level site. That makes cross-site authentication cookies less
portable and less predictable than they once were.

An app-owned `/verify-email` callback avoids that problem by using a narrow
token exchange at the application boundary:

1. The user clicks the Magic Link SSO email link.
2. The user lands on the application's `/verify-email` route.
3. The application exchanges the token with Magic Link SSO.
4. The application sets the final auth cookie on its own origin.

Because the session is established by the application itself, the resulting
cookie behaves like normal first-party session state instead of a third-party
cookie that may be blocked, partitioned, or inaccessible.

## When To Use Each Flow

### App-Owned `/verify-email`

Use this flow when:

- your application and Magic Link SSO are on different origins
- your deployment spans unrelated domains
- you want the most durable browser-compatible setup
- you want the final session cookie to be owned by the application

This is the default pattern used by the framework packages and examples because
it aligns with how browsers want authentication handoffs to work.

### Hosted `/verify-email`

Use this flow when:

- the application and Magic Link SSO are same-site
- both can share an appropriate cookie domain
- the cookie set by the server is readable by the destination application

This flow is still valid, but it is best described as a same-site or
shared-cookie-domain option rather than a general cross-domain SSO strategy.

## Browser Compatibility Notes

Browser platform guidance increasingly points developers away from shared
cross-site cookies as the foundation of authentication flows:

- Chrome's Privacy Sandbox guidance recommends preparing for third-party cookie
  restrictions and moving to alternatives that do not depend on unrestricted
  cross-site cookies.
- Chrome's CHIPS model partitions cookies by top-level site, which makes it a
  poor fit for one shared auth cookie across multiple unrelated application
  domains.
- Safari blocks cross-site cookies by default and points developers toward
  first-party authorization flows or the Storage Access API for embedded
  content.
- Firefox's Total Cookie Protection stores cookies in separate jars per site,
  which further weakens assumptions about shared cross-site session cookies.
- MDN documents the Storage Access API as a mechanism for embedded third-party
  content, not as the default pattern for top-level email-link authentication
  handoffs.

## Why CHIPS And Storage Access API Are Not The Default

CHIPS and the Storage Access API both solve narrower problems than the one Magic
Link SSO needs to solve for email-link authentication.

CHIPS is designed for partitioned cross-site state. That is useful when a
third-party service needs separate cookie state inside each top-level site, but
it does not provide one shared session cookie that works uniformly across
multiple unrelated domains.

The Storage Access API is designed for embedded third-party contexts that need
access to unpartitioned cookies. It typically involves browser-specific
permission behavior and prompting, and it is not the natural fit for a top-level
email-link verification handoff.

## Documentation Guidance

When documenting Magic Link SSO integrations:

- present the app-owned `/verify-email` callback as the default for cross-origin
  deployments
- describe the hosted `/verify-email` flow as appropriate for same-site or
  shared-cookie-domain setups
- avoid presenting `SameSite=None` as a future-proof cross-browser SSO model
- avoid positioning CHIPS or the Storage Access API as the primary integration
  strategy

## Sources

- [Chrome Privacy Sandbox: Prepare for the end of third-party cookies](https://privacysandbox.google.com/cookies/prepare/overview)
- [Chrome Privacy Sandbox: Cookies Having Independent Partitioned State (CHIPS)](https://privacysandbox.google.com/cookies/chips)
- [WebKit: Full Third-Party Cookie Blocking and More](https://webkit.org/blog/10218/full-third-party-cookie-blocking-and-more/)
- [Firefox: Total Cookie Protection](https://support.mozilla.org/en-US/kb/introducing-total-cookie-protection-standard-mode)
- [MDN: Storage Access API](https://developer.mozilla.org/en-US/docs/Web/API/Storage_Access_API)
