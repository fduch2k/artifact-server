# 0045: Review runs the version on its preview origin, not in an opaque-origin `srcdoc`

**Status:** Proposed
**Date:** November 28, 2026

Changes CMT-014 (wording and acceptance), supersedes the `srcdoc` parts of
the Review viewer architecture (artifact comments spec, section 9a), and
withdraws three mechanisms ADR 0044 added for the `srcdoc` document. Issue
#18.

## Context

Review renders an HTML entry from a `srcdoc` iframe with
`sandbox="allow-scripts"` and no `allow-same-origin`, inside `/review-frame`,
with a `<base href>` pointing at the version's preview lease host (CMT-014,
CMT-018). The document therefore has an opaque origin and the URL
`about:srcdoc`.

Single-page apps with a client-side router or browser storage render a blank
page there, while the same version opened by its raw link works. A Slidev talk
built with `slidev build` was verified in Chromium against the production
Review build:

| Build | Review | Raw version link |
| --- | --- | --- |
| history router, `routingMode: static` | blank | renders; reloading `/3` breaks |
| history router, `routingMode: spa` | blank | renders, navigates, reloads `/3` |
| `routerMode: hash` | blank | renders, navigates, reloads `#/3` |
| `routerMode: hash` + in-memory `localStorage` shim | the frame navigates to the browser error page | renders |

Two mechanisms produce this, and neither can be fixed inside an opaque
`srcdoc` document:

1. Reading `window.localStorage` in a sandbox without `allow-same-origin`
   throws `SecurityError`. Slidev reads it unguarded at startup and never
   mounts.
2. The document URL is `about:srcdoc` while its base is the preview host. A
   router's `history.replaceState` to a URL on the preview host is
   cross-origin and throws; the router's fallback assigns `location`, which
   navigates the sandboxed frame away.

The same boundary blocks URL workers, `blob:` workers, nested frames of the
version's own files, and integrity-pinned scripts that a runtime inserts
after rendering (issue #17, ADR 0044). ADR 0044 patched around the opaque
origin for files the parser sees, and recorded that the real export it was
written for still did not render.

`@plannotator/ui` 0.31, which Review already uses, has a live mode in
`HtmlViewer`: given `src` and `liveSession {origin, token}` it navigates the
iframe to a real URL instead of building a `srcdoc`, and expects the serving
side to inject the annotation bridge into its HTML responses. Every bridge
message in both directions carries the session token and is checked against
the live origin. Plannotator's own `annotate <url>` uses it through a loopback
proxy.

## Decision

### 1. The preview host serves Review, with the bridge injected

Review navigates the artifact frame to the entry document on the version's
preview lease host. When a preview lease host answers with an HTML document of
the version (`text/html`, including the SPA entry fallback), it inserts one
inline script before `</head>` (or at the start of the document when there is
no `</head>`) that holds:

- the live configuration: the per-lease bridge token, the application origin
  as the editor origin (on a local installation, each loopback name for it), the annotation CSS, and the frame depth at which
  Review hosts the document (2: shell, then review frame);
- the pinned `@plannotator/ui` live bootstrap and bridge script.

Like the `srcdoc` builder it replaces, the injection also neutralises an
authored `<meta http-equiv="Content-Security-Policy">`, which would otherwise
block the bridge. The injected response is `private, no-store`, carries no
`ETag` and no range support, and is never cached.

A frame navigation (`Sec-Fetch-Dest: iframe`) to a missing path of a SPA
version gets the entry on the preview host, as a top-level navigation does on
the raw link, so a routed app can be reloaded on a deep path inside Review.

Nothing else changes: stored bytes, digests, manifests, exact-version hosts,
current hosts, and public-link hosts serve the version's bytes exactly as
before. Non-HTML files on the preview host are served unchanged.

The bridge text is taken from the pinned dependency at web build time
(`review-bridge.json` in the web assets) so the server and the review frame
always run the same bridge version. A server without web assets serves no
Review and therefore injects nothing.

### 2. Review uses the viewer's live mode

The application document asks for a preview lease as before; the lease
response now also returns the lease's bridge token. It sends the review frame
the entry URL on the lease host and `{origin, token}`. The review frame
refuses any `src` whose origin is not exactly the given live origin, is not
`http:` or `https:`, or equals the review frame's own (application) origin.
The application document no longer reads the entry's bytes for Review.

The review frame and the bridge exchange messages only with the session
token and only between the application origin and the lease origin.

### 3. Isolation by a credential-free origin, with a sandbox

The artifact frame carries `sandbox="allow-scripts allow-same-origin"`.

- `allow-same-origin` gives the document its real origin, the lease host, so
  storage, the History API, workers, nested frames of its own files and
  same-origin requests behave as on the raw link.
- Without `allow-top-navigation*`, `allow-popups`, `allow-forms`,
  `allow-modals` and `allow-downloads`, the artifact can still not navigate
  the top window, open windows, submit forms, show modal dialogs, or start
  downloads. These are the same affordances it lacks in Review today, so no
  page loses anything it had.
- `allow-scripts` together with `allow-same-origin` lets a document remove its
  own sandbox only when it is same-origin with its embedder. The embedder is
  the review frame on the application origin and the artifact is on a content
  host, so it cannot; the review frame additionally refuses a `src` on its own
  origin.

The review frame's Content-Security-Policy gains `frame-src` for content
hosts. It no longer governs the artifact document, which is a navigation, not
a `srcdoc` child, and runs under its own response headers as on the raw link.

`@plannotator/ui` 0.31 renders live mode without any `sandbox` and lets the
bridge run only when its parent is the top window. A pinned patch
(`patches/@plannotator__ui@0.31.0.patch`):

- adds a `liveSandbox` prop for the live iframe;
- makes the bridge's frame gate compare its depth with the configured depth,
  so nested frames inside the artifact still do not run it;
- lets a live document's host-theme opt-in
  (`<meta name="plannotator-theme" content="host">`, CMT-023) come from the
  served configuration, since the viewer no longer sees the HTML; the preview
  host reads the meta tag when it injects;
- stops the viewer posting to the live iframe while it is still its initial
  `about:blank`, and lets the bridge post only to the parent origin the
  browser reports in `location.ancestorOrigins`, so neither side logs
  target-origin mismatches. Messages skipped before the bridge is ready are
  re-sent when it reports ready, as the viewer already does.

### 4. CMT-014 changes from "opaque origin" to "credential-free preview origin"

New wording: *The review viewer executes artifact HTML only in a sandboxed
frame on the version's preview lease origin, which holds no application
credential and cannot navigate the top window; comment writes happen only in
the signed-in application document.*

What CMT-014 protects against, and how each threat is covered before and
after:

| Threat | Opaque `srcdoc` (before) | Lease origin, sandboxed (after) |
| --- | --- | --- |
| Read the reviewer's application cookie or session | opaque origin has no cookies | the lease host has no cookies: application cookies are host-only on the application host (Browser security contract) and on hosted deployments on a different registrable domain (CNT-003); leases are never cookies (CMT-018) |
| Call the application API with the reviewer's credentials | review-frame CSP `connect-src` allows only content hosts; origin `null` | requests reach the network as from the raw link; the application grants no credentialed CORS to content origins, cookie-authenticated mutations require a CSRF token and reject content origins by `Origin` and Fetch Metadata, and bearer credentials never reach the frame |
| Read or drive the application document | cross-origin to the review frame and shell | still cross-origin; cannot lift its own sandbox (section 3) |
| Write a comment as the reviewer | only the application document writes; bridge messages only open the composer in the review frame | unchanged; the composer and every API call stay in application-origin documents |
| Read another version's or artifact's bytes | lease bound to one version | unchanged; the lease host serves one exact version |
| Navigate the reviewer away | no top navigation, no popups | unchanged |
| Leave state behind that affects the application or other versions | none possible | storage, service workers and caches live on the lease host, which is unique per lease and per version and is partitioned under the application as top-level site; no other version or the application shares it (CNT-004, CNT-006) |

What is weaker: the artifact loses one defence layer it had only in Review,
the review frame's `connect-src`. From Review it can now reach any network
origin, exactly as it can from its raw link, which every reviewer can already
open from the same screen. The remaining layers for the application API are
the ones raw links rely on today. In exchange the artifact also loses the
`'unsafe-inline'` review-frame policy it inherited and runs under no policy of
ours, as on the raw link.

What the artifact can newly do in Review: use `localStorage`,
`sessionStorage`, IndexedDB, cookies and Cache Storage on its lease host;
register a service worker on it; use the History API; start URL and `blob:`
workers; frame its own files; fetch its own files same-origin; and reach any
network origin. Its storage starts empty on each new lease.

The bridge token is not a secret from the artifact: the bridge runs in the
artifact's own JavaScript realm, so the artifact can read the injected
configuration, exactly as it could post any bridge message in `srcdoc` mode,
where there was no token. The token binds the messages to this lease's origin
and this view; it is not what stops a forged comment. A forged bridge message
can only open the composer or move a highlight in the review frame; posting a
comment requires the reviewer to submit the composer.

### 5. No `srcdoc` fallback

Every HTML entry, single-file or not, is reviewed live. Review already issues
a preview lease for every HTML entry, so the preview host is a hard dependency
today; a `srcdoc` fallback would only run when that host is unreachable, and
then relative files would fail as well. Keeping two rendering modes would
keep two security models and two sets of tests for one surface. If the lease
cannot be issued, Review shows its existing preview error with Open raw
artifact.

### 6. The lease follows the view

The preview lease lifetime stays 15 minutes. While a Review view is mounted,
the application document renews its lease every five minutes through
`POST .../preview-leases/renewals`, which re-checks that the signed-in
principal can still read the version and that the lease belongs to that
principal, artifact and version, and extends it to 15 minutes from now. A
removed member's or closed tab's lease therefore still ends within 15
minutes, as CMT-018 requires.

If renewal fails because the lease already expired (a sleeping laptop),
Review issues a new lease and reloads the frame on the new origin at the page
the reviewer was on. Storage made under the old lease is not carried over.

### 7. Pages of a routed app

The bridge reports the page (`pathname + search` on the lease host) when it
becomes ready and on every History API change. A comment created in Review
stores that page as `pageUrl` in its client-owned anchor. The viewer restores
only the comments of the current page plus comments without a page, so every
existing comment keeps showing as before. Show in page on a comment made on
another page navigates the frame to that page first. The page URL is
lease-independent, so it survives renewal and a new lease.

### 8. What happens to ADR 0044

- **Integrity `crossorigin` rewrite:** removed. The version's own scripts are
  same-origin with the document, so the browser checks their hashes as on
  the raw link, including scripts a runtime inserts later, which the rewrite
  never saw.
- **`<base href>` injection and the fragment-link script:** removed with
  `srcdoc`. Relative URLs and `#fragment` links resolve against the document's
  real URL.
- **Readable 404 on the preview host:** the 404 keeps `private, no-store` and
  `no-referrer`, but loses `Access-Control-Allow-Origin: *`, and found files
  lose it too. Requests from the document to its own files are same-origin, so
  CORS no longer serves Review, and no other origin needs to read a lease
  host.
- **Stalled-entry notice (CNT-011):** kept. The review frame still observes
  the artifact iframe's `load` without running code in it. Its text no longer
  says that Review lacks storage, workers and frames.

CNT-010 is reworded to the new mechanism instead of being replaced: its
outcome, a version loading its own files in Review as its origin would, is
the same.

## Consequences

- Slidev decks and other routed or storage-using apps render, navigate and
  reload inside Review, and can be commented on per page.
- Exports of the issue #17 kind lose the Review-only blockers (`blob:` workers,
  runtime-inserted integrity scripts). Whether that real export now renders
  has not been run; only synthetic fixtures are in the test suite.
- A comment made on page `/3` is not shown while the reviewer is on `/1`.
  It is still listed in the comment panel.
- A static-routed history app (`routingMode: static`) cannot be reloaded at a
  deep path on its raw link either; Show in page to such a page shows the
  version's 404, as the raw link would.
- On a local installation the preview host cannot see which loopback name
  (`localhost`, `127.0.0.1`, `[::1]`) the reviewer opened the application on,
  so the bridge lists all of them on the same scheme and port, as
  Plannotator's own proxy does. A deployment with a trusted application
  origin lists only that origin.
- The preview host now rewrites HTML responses, which costs one buffered read
  of each HTML document served to Review.

## Rejected alternatives

- **Keep `srcdoc` and shim storage and History.** A shim cannot give
  `about:srcdoc` a URL on the preview host, so routers still throw or
  navigate away, and workers, frames and late integrity scripts stay blocked.
- **`srcdoc` with `allow-same-origin`.** The document would take the review
  frame's application origin and could remove its own sandbox and call the
  API with the reviewer's cookie.
- **Proxy the version through the application origin, like Plannotator's
  loopback proxy.** Puts artifact code on the application origin.
- **Inject the bridge on exact-version, current and public-link hosts too.**
  Changes the bytes every visitor gets and tells the page it may be under
  review. The preview host exists only for Review.
- **Add `allow-forms` and `allow-popups`.** Not needed for the pages in this
  issue, and both are affordances the artifact does not have in Review today.
  Revisit with a concrete page that needs them.
- **Longer lease lifetime instead of renewal.** Lets a lease outlive the view
  and the reviewer's access by the whole lifetime.
- **Renew by issuing a new lease.** Changes the origin, so the frame reloads
  and loses storage every few minutes.
