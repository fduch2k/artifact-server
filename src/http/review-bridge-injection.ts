import { z } from "zod";

/**
 * Review runs a version's HTML on its preview lease origin and talks to it
 * through Plannotator's live annotation bridge (ADR 0045). Only the preview
 * host serves Review, so only its HTML responses carry the bridge; exact,
 * current, and public-link hosts serve stored bytes untouched.
 */

/** The bridge text copied from the pinned viewer at web build time. */
export const reviewBridgeSourceSchema = z.object({
  bootstrap: z.string().min(1),
  bridge: z.string().min(1),
  css: z.string(),
});

export type ReviewBridgeSource = z.infer<typeof reviewBridgeSourceSchema>;

/** Where the bridge may talk and how it proves it is this view's bridge. */
export interface ReviewBridgeSession {
  /** The application origins that may host the review frame. */
  readonly editorOrigins: readonly string[];
  readonly token: string;
}

/**
 * The review frame is the bridge's editor and is itself framed by the
 * application shell, so the artifact document sits two frames below the top.
 * Nested frames inside the artifact are deeper and keep the bridge inert.
 */
const reviewFrameDepth = 2;

/** HTML documents larger than this are served without a bridge. */
export const maximumBridgedHtmlBytes = 32 * 1024 * 1024;

const metaContentSecurityPolicy =
  /<meta\s[^>]*http-equiv\s*=\s*["']?\s*content-security-policy\s*["']?[^>]*\/?>/giu;
const headClose = /<\/head\s*>/iu;
const leadingDoctype = /^\s*<!doctype\b[^>]*>/iu;
const charsetParameter = /;\s*charset\s*=\s*"?([^";\s]+)"?/iu;
const metaCharset = /<meta\s[^>]*charset\s*=\s*["']?\s*([a-z0-9_.:-]+)/iu;

const loopbackHostnames = ["localhost", "127.0.0.1", "[::1]"] as const;

/**
 * The origins the review frame can be on. A deployment with a trusted
 * application origin has exactly that one. A local installation is reached
 * on its loopback listener under whichever loopback name the browser used,
 * which the preview host cannot see, so every loopback name on the same
 * scheme and port is listed; the browser delivers the bridge's post only to
 * the one the review frame is actually on.
 */
export function reviewEditorOrigins(
  applicationUrl: URL,
  trusted: boolean,
): readonly string[] {
  if (trusted) return [applicationUrl.origin];
  const origins = new Set<string>([applicationUrl.origin]);
  for (const hostname of loopbackHostnames) {
    const alias = new URL(applicationUrl.origin);
    alias.hostname = hostname;
    origins.add(alias.origin);
  }
  return [...origins];
}

/** Return whether a manifest media type is an HTML document. */
export function isHtmlMediaType(mediaType: string): boolean {
  return mediaType.split(";", 1)[0]?.trim().toLowerCase() === "text/html";
}

/**
 * Decode stored HTML bytes the way a browser would pick the encoding: the
 * response charset parameter, then a `<meta charset>` in the first kilobyte,
 * then UTF-8. Returns null for an encoding the runtime cannot decode, in which
 * case the document is served unchanged.
 */
export function decodeHtml(bytes: Uint8Array, mediaType: string): string | null {
  const declared = charsetParameter.exec(mediaType)?.[1]
    ?? metaCharset.exec(new TextDecoder("latin1").decode(bytes.subarray(0, 1024)))?.[1]
    ?? "utf-8";
  try {
    return new TextDecoder(declared).decode(bytes);
  } catch {
    return null;
  }
}

/**
 * Insert the live configuration and bridge before `</head>`, where the
 * viewer's own `srcdoc` builder put it, so the document's `<meta charset>`
 * stays in its first kilobyte. An authored Content-Security-Policy `<meta>`
 * would block the inline bridge and is neutralised, as the viewer does.
 */
export function injectReviewBridge(
  html: string,
  source: ReviewBridgeSource,
  session: ReviewBridgeSession,
): string {
  const config = scriptSafeJson({
    css: source.css,
    editorOrigins: session.editorOrigins,
    frameDepth: reviewFrameDepth,
    token: session.token,
  });
  const script = [
    "<script data-artifact-server-review-bridge>",
    `window.__plannotatorLiveConfig=${config};`,
    source.bootstrap,
    ";",
    source.bridge,
    "</script>",
  ].join("\n");
  const document = html.replace(
    metaContentSecurityPolicy,
    "<!-- artifact-server: meta CSP removed for Review -->",
  );
  const head = headClose.exec(document);
  if (head !== null) {
    return document.slice(0, head.index) + script + document.slice(head.index);
  }
  const doctype = leadingDoctype.exec(document);
  if (doctype !== null) {
    const end = doctype.index + doctype[0].length;
    return document.slice(0, end) + script + document.slice(end);
  }
  return script + document;
}

/** JSON that cannot close the surrounding `<script>` or break a JS string. */
function scriptSafeJson(value: unknown): string {
  return JSON.stringify(value)
    .replaceAll("<", "\\u003c")
    .replaceAll(">", "\\u003e")
    .replaceAll("&", "\\u0026")
    .replaceAll(" ", "\\u2028")
    .replaceAll(" ", "\\u2029");
}
