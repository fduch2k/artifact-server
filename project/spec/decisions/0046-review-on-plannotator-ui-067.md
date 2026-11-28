# 0046: Review moves to @plannotator/ui 0.67 and runs single-page apps in its srcdoc sandbox

**Status:** Proposed
**Date:** November 28, 2026

Builds on the Review sandbox (CMT-014): artifact HTML runs in a `srcdoc`
iframe with `sandbox="allow-scripts"`, inside `/review-frame`, whose
Content-Security-Policy lets the page reach only content hosts. Amends
[0044: Review loads a version's own files as its origin would](0044-review-entry-loading.md).
Refs issue #18.

## Context

Review was pinned to `@plannotator/ui` 0.31. Exported slide decks and other
single-page apps went blank in Review: their router calls
`history.replaceState` while it starts, and their state code reads
`localStorage`. In an opaque-origin `srcdoc` document both throw a
`SecurityError`, and the app stops before it draws anything.

0.67 adds a sandbox shim to the `srcdoc` frame. It applies a pushed or
replaced URL to the frame's own address when the browser would refuse the
URL the page passed, keeping only its fragment, and it gives the page an
in-memory `localStorage` and `sessionStorage` for one load. The sandbox
flags do not change.

A spike compared two ways to use 0.67, on synthetic decks that follow
vue-router's history shapes (a hash router pushing `#/2`, a history router
pushing `/2`), with workers from a URL and from a blob, and with comments on
two slides:

- **A. `srcdoc` and the shim**, the Review we already have, on 0.67.
- **B. Live mode** (branch `feat/review-live-mode`): the frame loads the
  version from its preview host as a real origin, and the live bridge
  connects it to the viewer.

| Fixture | A: `srcdoc` and shim | B: live mode, 0.67 without a patch |
| --- | --- | --- |
| Hash router: render, page, reload the frame | works; the slide survives a reload (`about:srcdoc#/2`), storage does not | works; slide and storage survive a reload |
| History router: render and page | works; the route stays in memory, the address stays `about:srcdoc` | works, the address follows the route |
| History router: reload the frame | back to the first slide | stays on the slide (SPA routing on the preview host) |
| Worker from a URL | `SecurityError` | works |
| Worker from a `blob:` URL | refused by the review-frame `script-src`, the `worker-src` fallback | works |
| Comments on two slides | saved, but drawn on every slide where the anchor matches | the composer never opens: the bridge does not start |

The owner then opened a real exported Slidev deck in Review on option A,
built with the hash router and with the history router, and it rendered and
paged in both.

## Decision

1. **Pin `@plannotator/ui` 0.67.0** and keep Review's `srcdoc` frame. The
   frame's `sandbox` stays `allow-scripts` only. 0.67 defaults to adding
   `allow-modals`, so Review passes `sandbox="allow-scripts"` explicitly.
2. **Let the shim run single-page apps** (CNT-016). Review gains nothing
   beyond what the shim gives:

   | Works | Does not work |
   | --- | --- |
   | A hash router, including its route across a reload of the frame | Workers from a URL (`SecurityError` in an opaque origin) or from `blob:` (review-frame `script-src`) |
   | A history router, with its route kept in memory; a reload of the frame starts over at the first route | Restoring a history route on reload: the frame has no served address |
   | `localStorage` and `sessionStorage` that live for one load of the page and reach no other document | Storage that survives a reload, or that another page or tab sees |
   | `pushState` and `replaceState` that never move the frame or Review off its address | Comments that know which page of a single-page app they belong to: a comment is drawn wherever its anchor matches, on every page |

3. **Restore `#top` with our own handler, not a patch.** In 0.67 the
   viewer's bridge owns fragment links: a capture listener on the
   document cancels every followed `#` link and scrolls to the element it
   names. It does not handle `#top`, which HTML defines as the top of the
   document when no element carries that name, so the link did nothing.
   Review's injected fragment script now listens on the window in the
   capture phase, which every click reaches before the bridge's document
   listener. For a plain click on `#top` with no matching element it scrolls
   to the start and cancels the click, so the bridge leaves it alone. Every
   other fragment link is the bridge's. Review's older fragment handler is
   gone: the bridge now does what it did.
4. **Accept three behavior changes that 0.67 does not let a host configure.**
   Third-party code is not patched, vendored, or copied, so each stays as 0.67
   ships it. Readers of Review see them:
   - **Looks good.** The selection toolbar offers a one-click Looks good
     comment beside Copy and Comment. `HtmlViewer` always passes the
     toolbar a hard-coded Looks good handler and has no prop to turn it
     off. A click saves a thread with that text on the selection; it does
     not open the composer.
   - **Links in Annotate mode.** A plain click on a link with a
     destination follows it, as in Interact mode; Ctrl-click or Cmd-click pins
     it for a comment. In 0.31 a plain click pinned it. The rule is in
     the bridge's click handler, with no prop. A link with no destination
     (`href="#"`, empty, `javascript:`) still pins on a plain click.
   - **The page cancelling a fragment link.** The bridge scrolls in the
     document's capture phase, before the page's own element and document
     handlers. Those handlers still run, but cancelling the click no longer
     stops the scroll. In 0.31 Review scrolled after them and respected a
     cancellation (CMT-022-F said so). Review could only restore this by
     taking every fragment link away from the bridge and replacing the
     event's `preventDefault` to see whether the page called it. That fights
     the package's own handling, so this decision does not do it.

Nothing here changes the sandbox flags, the review-frame
Content-Security-Policy, or what artifact code can reach.

## Live mode is deferred

Live mode gives a single-page app everything A lacks: a real origin, a route
that survives reloads, durable storage, and workers. It does not ship now,
because on 0.67 its comments do not work at all without a patch:

- The 0.67 live bridge starts only when the editor window is `window.top`,
  directly or through one wrapper frame (`LIVE.nested`). Review keeps the
  viewer in its own frame (shell, then `/review-frame`, then the app), so the
  gate stops the bridge. With `nested` the bridge talks to the shell instead
  of the review frame, and both sides reject relayed messages because their
  `source` and `origin` do not match. `window.top` cannot be redefined.
- Merging `/review-frame` into the shell would pass the gate but put
  third-party viewer code in the document that holds the session and CSRF
  token, which CMT-014 and the separate review frame exist to prevent. It
  would also need `style-src 'unsafe-inline'` in the shell. That is a change
  to the trust model, not part of an upgrade.

The way forward is upstream. Proposed text, not yet filed:

> **Live bridge: support an editor that is itself framed.** `BRIDGE_SCRIPT`
> runs only when the editor window is `window.top` (directly, or through a
> `LIVE.nested` wrapper). A host that keeps the viewer in its own isolated
> frame (application shell, viewer frame, live app, so third-party viewer
> code never shares a document with the session) cannot use live mode: the
> gate stops the bridge, and `nested` makes it talk to the shell instead of
> the viewer frame. Proposal: an optional `LIVE.editorDepth` (default 0 =
> top). The bridge runs only when its own frame depth equals
> `editorDepth + 1` (or `+ 2` with `nested`), and `EDITOR` is the ancestor
> at that depth. Defaults keep today's behaviour byte-for-byte; origin and
> token checks are unchanged.

Separately, `#top` is worth an upstream issue: the bridge's fragment scroll
does not handle it.

The live-mode work stays on `feat/review-live-mode` (and the 0.67 spike on
`spike/pn067-live`), unmerged, until the bridge supports a framed editor.

## What changes in ADR 0044

- **Storage.** 0044 left storage out of Review. With the shim a page gets
  `localStorage` and `sessionStorage` for one load. The stalled-page notice no
  longer says Review runs pages "without storage": it says storage lasts one
  load.
- **Workers and nested frames** are unchanged: URL workers still throw,
  `blob:` workers are still refused by the review-frame policy, and frames of
  version files are still refused by `default-src 'none'`. Its open follow-up
  on `blob:` workers stands. Live mode would answer it without changing the
  `srcdoc` sandbox.
- The readable 404, the integrity rewrite, and the stalled-page notice are
  unchanged.

## Requirements

| ID | Requirement |
| --- | --- |
| CNT-016 | Review renders a single-page app that uses the History API and storage while it starts: a hash router pages and keeps its route across a reload of the frame, a history router pages in memory, storage lives for one load, and none of it moves Review, reaches another document, or widens the scripts-only sandbox. |

CMT-022 and CMT-024 are reworded for the behavior changes in decision 4.

## Consequences

- Exported decks with a hash or history router render and page in Review.
  A reload of the frame keeps a hash route and loses a history route.
- Comments on a single-page app are not tied to a page. A comment's marker
  shows on every page where its anchor matches, and a comment on one slide
  can cover the same element on another. Issue #18 stays open for this.
- Pages that need workers still stop in Review.
- Readers see the Looks good button, follow links with a plain click in
  Annotate mode, and pin a link with Ctrl-click or Cmd-click.
- The viewer's TypeScript surface is our own `.d.ts` under
  `review-frame/plannotator/`, so a later upgrade is checked by browser
  tests, not by the compiler.

## Rejected alternatives

- **Patch the package** (a `patchedDependencies` entry or a vendored copy)
  to keep 0.31 behavior or lift the live gate. A patch has to be ported again
  on every upgrade and moves away from the shipped package; the decisions
  above are reachable without one.
- **Live mode now, with the shell and review frame merged.** Changes the
  trust model of CMT-014 and the shell's style policy; see above.
- **Stay on 0.31.** Single-page apps keep going blank in Review.
- **Make a plain click in Annotate mode pin a link again** by turning it
  into a modified click in our own script. That rewrites the bridge's input
  from outside and breaks the next time the bridge changes its rule.
