import {
  HtmlViewer,
  type Annotation,
  type HtmlLiveSession,
  type ViewerHandle,
} from "@plannotator/ui/components/html-viewer";
import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";

import {
  hostMessageSchema,
  reviewAnchorFrom,
  reviewProtocolVersion,
  type FrameMessage,
  type ReviewAnnotation,
  type ReviewInit,
  type ReviewSource,
  type ReviewTheme,
} from "./protocol.ts";

/**
 * The artifact runs on its own preview lease origin (ADR 0045). Same-origin
 * gives it storage, routing, and workers there; the remaining sandbox keeps it
 * from navigating the top window, opening windows, submitting forms, showing
 * modal dialogs, or downloading, as before. Because that origin is never this
 * frame's, the document cannot lift its own sandbox.
 */
const artifactSandbox = "allow-scripts allow-same-origin";

/** Where the live viewer points, already checked against its session. */
interface LiveSource {
  readonly live: HtmlLiveSession;
  /** Bumped to reload the viewer even when the URL repeats. */
  readonly navigation: number;
  readonly src: string;
}

interface ReviewSession {
  readonly annotateModeActive: boolean;
  readonly annotations: Annotation[];
  readonly entryPath: string;
  readonly readOnly: boolean;
  /** Null when the host named a source this frame refuses to load. */
  readonly source: LiveSource | null;
  readonly supportsAnnotateMode: boolean;
}

/**
 * Accept only an http(s) URL on exactly the live origin, and never this
 * frame's own origin: a same-origin artifact with scripts could remove its
 * own sandbox and reach the application.
 */
function liveSourceFrom(
  message: ReviewInit | ReviewSource,
  navigation: number,
): LiveSource | null {
  let url: URL;
  try {
    url = new URL(message.src);
  } catch {
    return null;
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") return null;
  if (url.origin !== message.liveOrigin) return null;
  if (url.origin === window.location.origin) return null;
  return {
    live: {origin: url.origin, token: message.liveToken},
    navigation,
    src: url.toString(),
  };
}

/** Project one host thread into the record the viewer paints and numbers. */
function toAnnotation(review: ReviewAnnotation): Annotation {
  const annotation: Annotation = {
    blockId: "",
    createdA: 0,
    endOffset: 0,
    id: review.threadId,
    originalText: review.anchor?.originalText ?? "",
    startOffset: 0,
    text: review.body,
    type: "COMMENT",
  };
  const anchor = review.anchor;
  if (anchor === null) return annotation;
  if (anchor.pageUrl !== undefined) annotation.pageUrl = anchor.pageUrl;
  if (anchor.htmlAnchor !== null) annotation.htmlAnchor = anchor.htmlAnchor;
  if (anchor.htmlAdditionalTargets !== undefined) {
    annotation.htmlAdditionalTargets = anchor.htmlAdditionalTargets;
  }
  return annotation;
}

function sessionFrom(init: ReviewInit): ReviewSession {
  return {
    annotateModeActive: init.annotateModeActive ?? true,
    annotations: init.annotations.map(toAnnotation),
    entryPath: init.entryPath,
    readOnly: init.readOnly,
    source: liveSourceFrom(init, 0),
    supportsAnnotateMode: init.annotateModeActive !== undefined,
  };
}

/** Point the viewer at another page of the same live origin. */
function withPage(session: ReviewSession, pageUrl: string): ReviewSession {
  const source = session.source;
  if (source === null) return session;
  return {
    ...session,
    source: {
      ...source,
      navigation: source.navigation + 1,
      src: new URL(pageUrl, source.live.origin).toString(),
    },
  };
}

/** Adopt the host's palette so the viewer chrome and the sandbox agree. */
function applyTheme(theme: ReviewInit | ReviewTheme): void {
  const root = document.documentElement;
  for (const [token, value] of Object.entries(theme.themeTokens)) {
    root.style.setProperty(token, value);
  }
  root.classList.toggle("light", theme.isLight);
}

/**
 * The review frame: a same-origin document whose only job is to host
 * `@plannotator/ui`'s live HTML annotation surface over the version's preview
 * origin and relay its events to the application shell. It holds no
 * credential, makes no request, and learns everything it renders from one
 * validated `as-review-init` message.
 */
export function ReviewFrame(): React.ReactNode {
  const [session, setSession] = useState<ReviewSession | null>(null);
  const [selectedThreadId, setSelectedThreadId] = useState<string | null>(null);
  const [currentPageUrl, setCurrentPageUrl] = useState<string | undefined>(undefined);
  const currentPageUrlRef = useRef<string | undefined>(undefined);
  const viewerRef = useRef<ViewerHandle | null>(null);
  const surfaceRef = useRef<HTMLDivElement | null>(null);
  const paintedIdsRef = useRef<ReadonlySet<string>>(new Set<string>());

  const send = useCallback((message: FrameMessage): void => {
    window.parent.postMessage(message, window.location.origin);
  }, []);

  // `load` does not bubble, but it does pass this ancestor in the capture
  // phase. Listening here, before the viewer commits its sandbox iframe,
  // sees the artifact document finish loading without running any code in
  // it. The host owns the decision about how long is too long.
  useLayoutEffect(() => {
    const surface = surfaceRef.current;
    if (surface === null || window.parent === window) return undefined;
    const onLoad = (event: Event): void => {
      if (!(event.target instanceof HTMLIFrameElement)) return;
      send({type: "as-review-entry-loaded", v: reviewProtocolVersion});
    };
    surface.addEventListener("load", onLoad, true);
    return () => surface.removeEventListener("load", onLoad, true);
  }, [send]);

  useEffect(() => {
    // Framed by the application shell or nothing: a top-level review frame has
    // no host to authenticate against, so it never listens and never speaks.
    const framed = window.parent !== window;
    const onMessage = (event: MessageEvent<unknown>): void => {
      if (event.source !== window.parent) return;
      if (event.origin !== window.location.origin) return;
      const parsed = hostMessageSchema.safeParse(event.data);
      if (!parsed.success) return;
      const message = parsed.data;
      if (message.type === "as-review-init") {
        applyTheme(message);
        paintedIdsRef.current = new Set(
          message.annotations.map((annotation) => annotation.threadId),
        );
        setSession(sessionFrom(message));
        return;
      }
      if (message.type === "as-review-theme") {
        applyTheme(message);
        return;
      }
      if (message.type === "as-review-source") {
        setSession((current) => {
          if (current === null) return current;
          const navigation = (current.source?.navigation ?? 0) + 1;
          return {...current, source: liveSourceFrom(message, navigation)};
        });
        return;
      }
      if (message.type === "as-review-annotations") {
        const annotations = message.annotations.map(toAnnotation);
        setSession((current) =>
          current === null ? current : {...current, annotations}
        );
        return;
      }
      if (message.type === "as-review-annotate-mode") {
        setSession((current) =>
          current === null
            ? current
            : {...current, annotateModeActive: message.active}
        );
        return;
      }
      // Show in page for a comment made on another page of a routed or
      // multi-page version opens that page first.
      const threadId = message.threadId;
      setSession((current) => {
        if (current === null || threadId === null) return current;
        const pageUrl = current.annotations.find(
          (annotation) => annotation.id === threadId,
        )?.pageUrl;
        if (pageUrl === undefined || pageUrl === currentPageUrlRef.current) {
          return current;
        }
        return withPage(current, pageUrl);
      });
      setSelectedThreadId(threadId);
    };
    if (framed) {
      window.addEventListener("message", onMessage);
      send({type: "as-review-ready", v: reviewProtocolVersion});
    }
    return () => {
      window.removeEventListener("message", onMessage);
    };
  }, [send]);

  // The viewer paints marks for its initial prop set when the bridge reports
  // ready; every later arrival or removal is reconciled by id so a replaced
  // optimistic annotation leaves no orphan marker behind.
  const annotations = session?.annotations;
  useEffect(() => {
    const viewer = viewerRef.current;
    if (viewer === null || annotations === undefined) return;
    const painted = paintedIdsRef.current;
    const next = new Set(annotations.map((annotation) => annotation.id));
    for (const id of painted) {
      if (!next.has(id)) viewer.removeHighlight(id);
    }
    const added = annotations.filter(
      (annotation) => !painted.has(annotation.id),
    );
    if (added.length > 0) viewer.applySharedAnnotations(added);
    paintedIdsRef.current = next;
  }, [annotations]);

  const handlePageChange = useCallback((pageUrl: string): void => {
    currentPageUrlRef.current = pageUrl;
    setCurrentPageUrl(pageUrl);
    send({pageUrl, type: "as-review-page", v: reviewProtocolVersion});
  }, [send]);

  const handleAdd = useCallback((created: Annotation): void => {
    const pageUrl = currentPageUrlRef.current;
    const annotation: Annotation = pageUrl === undefined
      ? created
      : {...created, pageUrl};
    setSession((current) =>
      current === null
        ? current
        : {...current, annotations: [...current.annotations, annotation]}
    );
    send({
      anchor: reviewAnchorFrom(
        annotation.originalText,
        annotation.htmlAnchor,
        annotation.htmlAdditionalTargets,
        pageUrl,
      ),
      body: annotation.text ?? "",
      originalText: annotation.originalText,
      type: "as-review-submit",
      v: reviewProtocolVersion,
    });
  }, [send]);

  const handleSelect = useCallback((threadId: string | null): void => {
    setSelectedThreadId(threadId);
    send({threadId, type: "as-review-select", v: reviewProtocolVersion});
  }, [send]);

  const handleUnanchored = useCallback((threadIds: string[]): void => {
    send({threadIds, type: "as-review-unanchored", v: reviewProtocolVersion});
  }, [send]);

  const requestAnnotateMode = useCallback((active: boolean): void => {
    send({
      active,
      type: "as-review-annotate-mode-request",
      v: reviewProtocolVersion,
    });
  }, [send]);

  return (
    <div className="review-frame-surface" ref={surfaceRef}>
      {session === null ? (
        <p className="p-4 text-sm text-muted-foreground" role="status">
          Waiting for the artifact to load.
        </p>
      ) : session.source === null ? (
        <p className="p-4 text-sm text-muted-foreground" role="alert">
          Review could not open this version&apos;s preview.
        </p>
      ) : (
        <HtmlViewer
          annotateModeActive={session.annotateModeActive}
          annotations={session.annotations}
          currentPageUrl={currentPageUrl}
          fullViewport
          hideControls
          inputMethod="pinpoint"
          // A text selection first offers Copy and Comment and keeps focus on
          // the artifact, so a reader can copy what they selected. "comment"
          // would open the composer on every selection and take focus with it.
          // A pinpoint click still opens the composer directly in both modes.
          mode="selection"
          onAddAnnotation={handleAdd}
          onAnnotateModeExit={session.supportsAnnotateMode
            ? () => requestAnnotateMode(false)
            : undefined}
          onAnnotateModeToggle={session.supportsAnnotateMode
            ? () => requestAnnotateMode(!session.annotateModeActive)
            : undefined}
          onSelectAnnotation={handleSelect}
          onUnanchoredChange={handleUnanchored}
          key={session.source.navigation}
          liveSandbox={artifactSandbox}
          liveSession={session.source.live}
          onPageChange={handlePageChange}
          rawHtml=""
          readOnly={session.readOnly}
          ref={viewerRef}
          selectedAnnotationId={selectedThreadId}
          src={session.source.src}
          title={`Artifact review: ${session.entryPath}`}
        />
      )}
    </div>
  );
}
