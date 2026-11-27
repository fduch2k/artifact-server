# 0044: Review loads a version's own files as its origin would, and says when a page has not finished

**Status:** Proposed
**Date:** November 27, 2026

Builds on the Review sandbox (CMT-014): artifact HTML runs in a `srcdoc`
iframe with `sandbox="allow-scripts"`, inside `/review-frame`, whose
Content-Security-Policy lets the page reach only content hosts. Relative
resources resolve through an exact-version preview host (CMT-018).

## Context

A slide deck exported whole from another artifact platform, together with its
viewer runtime, published without error but showed its own loading skeleton
in Review forever. The viewer does not read its content directly: it first
asks for `_files.json` next to the entry page and expects a listing of the
version's files. Artifact Server has no such path. Opened directly, the same
deck ends in the viewer's own "No slides to show in this view"; with a
listing beside it, the deck renders.

A synthetic page that reproduces the viewer's moves (listing fetch, nested
iframe, URL and blob workers, `<script integrity>` from the version, dynamic
import) was driven through the real Review in Chromium. Against the same page
opened on its own origin, Review differed in five ways:

| Feature | Opened directly | In Review before this decision |
| --- | --- | --- |
| `fetch("_files.json")`, file missing | resolves with 404 | rejects with a network error: the preview host's 404 had no `Access-Control-Allow-Origin`, so the opaque-origin page could not read it |
| `<script integrity>` from the version, no `crossorigin` | same-origin, hash checked, runs | cross-origin without CORS, hash cannot be checked, blocked |
| `new Worker("worker.js")` | runs | throws `SecurityError`: an opaque origin cannot start a worker from a URL |
| `new Worker(blob:)` | runs | blocked by `script-src`, the `worker-src` fallback |
| `<iframe src="...">` of a version file | loads | blocked by `default-src 'none'`, the `frame-src` fallback |

The page still fired `load` in about 170 ms. None of these blocks `load` on
its own. The first row fits the symptom exactly: a viewer that treats a
missing listing (404) as "no slides" and a network failure as "wait" ends in
its empty state when opened directly and keeps its skeleton in Review. The
real export was not run here, so this is the best-supported cause, not a
proven one, and the export also uses workers.

## Decision

1. **Readable not-found on the preview host.** A missing file on a preview
   host answers the same `404 VERSION_NOT_FOUND` body with
   `Access-Control-Allow-Origin: *`, `Cache-Control: private, no-store`, and
   `Referrer-Policy: no-referrer`, as found files already do. Only a valid
   lease reaches a file lookup; a forged lease is still refused first. A
   holder of the lease can already read every file in the version, so being
   able to read "not here" as well reveals nothing new. Exact-version and
   current hosts are unchanged.
2. **Integrity checks in CORS mode for the version's own files.** Before
   rendering, Review adds `crossorigin="anonymous"` to a `<script integrity>`
   or `<link integrity>` that has no `crossorigin` and resolves to the
   version's preview origin. The browser then fetches the same URL and bytes
   and can check the hash, as it does when the page runs on its own origin.
   A wrong hash stays blocked. Resources on any other origin keep their
   authored attributes.
3. **A bounded "not finished loading" notice.** The review frame listens, in
   the capture phase on an ancestor of the sandbox iframe, for that iframe's
   `load` event and tells the application shell. If it has not arrived 15
   seconds after the frame received the document, Review shows a notice over
   the top of the preview: the entry path, that the page has not finished
   loading, that Review runs pages without storage, workers, or embedded
   frames, an **Open raw artifact** button and **Keep waiting**. The page stays
   visible underneath, and the notice disappears if the page finishes. The
   event is the browser's, observed outside the sandbox, so artifact code can
   neither send nor suppress it; a forged message from the page is ignored.

Nothing here changes the sandbox flags or the review-frame
Content-Security-Policy. Artifact code reaches no origin it could not reach
before.

## Requirements

| ID | Requirement |
| --- | --- |
| CNT-010 | Review loads a version's own files as the version's origin would: a missing file on the preview host is a readable cross-origin 404, and a same-version script or stylesheet with an integrity hash is fetched in CORS mode so its hash is checked; the sandbox flags and the review-frame policy are unchanged, and resources on other origins keep their authored attributes. |
| CNT-011 | When the artifact document in Review has not fired `load` within a bounded time, Review says so over the preview, keeps the page visible, offers the raw artifact and to keep waiting, and clears the notice once the page finishes; artifact code cannot hide the notice. |

## Consequences

- A page that probes for optional files reaches the same state in Review as
  opened directly instead of waiting on a network error.
- A version whose runtime is pinned by integrity hashes runs in Review.
- A slow page that is still working gets the notice after 15 seconds; Keep
  waiting dismisses it for that view.
- A page that fires `load` but then waits forever on something else, such as
  a worker that Review cannot start, still gets no notice. Review cannot tell
  "rendered" from "still drawing" for arbitrary HTML.

## Not part of this decision

- Workers, nested frames of version files, and storage in Review. Each needs
  `allow-same-origin`, `worker-src`, or `frame-src`, which changes the
  sandbox boundary (CMT-014) and is its own decision.
- Detecting pages that render nothing after `load`.

## Rejected alternatives

- **Serve a synthesized `_files.json` per version from the manifest** (the
  issue's first option). It would let such a deck render when the listing is
  its only blocker, and the version's own `_files.json` would win. Rejected
  for now: the real export was not run, so it is not shown that the listing is
  its only blocker (it also starts workers, which Review cannot run); it adds
  a reserved path to every version to match one other platform's convention;
  and on public-link hosts it would publish a full file list where today a
  visitor needs the paths. The readable 404 above already turns the stall
  into the viewer's own empty state. Revisit with the export in hand, scoped
  to preview hosts.
- **Allow `worker-src blob:` and `frame-src` for content hosts in the
  review-frame policy.** Changes what artifact code can do inside the sandbox;
  out of scope without its own security review.
- **Inject a script into the artifact to report `load`.** Runs our code in the
  artifact document, can be blocked by the artifact's own policy, and lets
  the artifact forge it. The iframe element's own `load` needs neither.
- **Time out and replace the preview with an error state.** Hides a page that
  is slow but working; the notice keeps it visible.
