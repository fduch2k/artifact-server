import {isDocumentNavigation} from "./spa-navigation.js";

/**
 * Failures a person can meet while their browser follows a private link or
 * returns from the identity provider. Each has one page a person can act on.
 */
export const browserFailurePages = {
  admissionRefused: "admission_refused",
  linkNotFound: "link_not_found",
  signInUnfinished: "sign_in_unfinished",
} as const;

export type BrowserFailurePage =
  typeof browserFailurePages[keyof typeof browserFailurePages];

interface BrowserFailurePageCopy {
  readonly action: string | null;
  readonly explanation: string;
  readonly title: string;
}

const pageCopy = {
  admission_refused: {
    action: null,
    explanation:
      "Your identity provider signed you in, but this Artifact Server has not admitted your account. Ask an administrator of this Artifact Server to give you access, then open the link again.",
    title: "You do not have access yet",
  },
  link_not_found: {
    action: null,
    explanation:
      "This link does not open an artifact you can see. Check that the link is complete. If someone shared it with you, ask them or an administrator of this Artifact Server for access.",
    title: "Artifact not available",
  },
  sign_in_unfinished: {
    action: "Sign in again",
    explanation:
      "Signing in did not finish, for example because the sign-in page was open too long or was used twice. Open the link you wanted again, or sign in again.",
    title: "Sign-in did not finish",
  },
} as const satisfies Readonly<Record<BrowserFailurePage, BrowserFailurePageCopy>>;

/**
 * Decide whether a failed request should be answered with a page for a
 * person: a `GET` document navigation as ADR 0035 defines it. Programs,
 * embedded loads, and `HEAD` requests keep the JSON error.
 */
export function prefersBrowserFailurePage(method: string, headers: Headers): boolean {
  return method === "GET" && isDocumentNavigation(headers);
}

/**
 * Build the page response. It carries no request detail, so the same failure
 * answers with the same bytes whatever caused it.
 */
export function browserFailurePageResponse(
  page: BrowserFailurePage,
  status: number,
): Response {
  return new Response(browserFailurePageHtml(page), {
    headers: {
      "Cache-Control": "private, no-store",
      "Content-Security-Policy":
        "default-src 'none'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'; style-src 'unsafe-inline'",
      "Content-Type": "text/html; charset=utf-8",
      "Referrer-Policy": "no-referrer",
      "X-Content-Type-Options": "nosniff",
      "X-Robots-Tag": "noindex, nofollow",
    },
    status,
  });
}

function browserFailurePageHtml(page: BrowserFailurePage): string {
  const copy = pageCopy[page];
  return [
    "<!doctype html>",
    '<html lang="en">',
    '<meta charset="utf-8">',
    '<meta name="viewport" content="width=device-width, initial-scale=1">',
    `<title>${copy.title}</title>`,
    "<style>body{font:16px/1.5 system-ui,sans-serif;max-width:32rem;margin:15vh auto;padding:0 1rem}a{font-weight:600}</style>",
    `<h1>${copy.title}</h1>`,
    `<p>${copy.explanation}</p>`,
    ...copy.action === null ? [] : [`<p><a href="/auth/login?returnTo=%2F">${copy.action}</a></p>`],
    "</html>",
    "",
  ].join("\n");
}
