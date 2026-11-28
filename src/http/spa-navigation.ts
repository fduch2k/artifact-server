/**
 * Decide whether a missing path may resolve to a single-page application's
 * HTML entry file.
 */
export function permitsSpaEntryFallback(headers: Headers): boolean {
  return isDocumentNavigation(headers);
}

/**
 * The preview host serves Review, which opens the version inside a frame
 * (ADR 0045), so a frame navigation to a missing path of a SPA version gets
 * the entry exactly as a top-level navigation on the raw link does.
 */
export function permitsFramedSpaEntryFallback(headers: Headers): boolean {
  if (permitsSpaEntryFallback(headers)) return true;
  if (!acceptsHtml(headers.get("accept"))) return false;
  return headers.get("sec-fetch-dest")?.toLowerCase() === "iframe"
    && headers.get("sec-fetch-mode")?.toLowerCase() === "navigate";
}

/**
 * Decide whether a request is a person's browser opening a page, as opposed
 * to a script, an asset, or a program that reads the response itself.
 */
export function isDocumentNavigation(headers: Headers): boolean {
  if (!acceptsHtml(headers.get("accept"))) return false;
  const destination = headers.get("sec-fetch-dest");
  if (destination !== null && destination.toLowerCase() !== "document") {
    return false;
  }
  const mode = headers.get("sec-fetch-mode");
  return mode === null || mode.toLowerCase() === "navigate";
}

function acceptsHtml(accept: string | null): boolean {
  if (accept === null) return false;
  return accept.split(",").some((candidate) => {
    const [mediaRange, ...parameters] = candidate.trim().toLowerCase().split(";");
    if (mediaRange !== "text/html") return false;
    const quality = parameters.find((parameter) => parameter.trim().startsWith("q="));
    if (quality === undefined) return true;
    const value = Number(quality.trim().slice(2));
    return Number.isFinite(value) && value > 0;
  });
}
