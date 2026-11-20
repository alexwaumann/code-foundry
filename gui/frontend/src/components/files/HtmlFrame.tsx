import { useCallback, useEffect, useMemo, useRef, useState, type CSSProperties } from "react";
import { LoaderCircle, RotateCw } from "lucide-react";
import { Button } from "@/components/ui/button";
import { createBridgeHost, type BridgeHost, type PageBridge } from "@/stores/bridgeHost";
import { watchFrameAttention } from "@/lib/frameAttention";
import { frameNonce, nonceMatches, withNonce } from "@/lib/bridge";
import { addPageError, type PageError } from "@/lib/pageErrors";
import { frameShapeOf, pageRefusalOf, scriptErrorOf, type PageCheckTap } from "@/lib/pageCheck";
import { activeThemeSlots, onThemePublished, subscribeThemeSlots, themeFrameMessage, useActiveTheme } from "@/lib/theme";
import { cn } from "@/lib/utils";
import { zoomFactor } from "@/lib/zoom";
import { fileWatcher } from "@/stores/fileStamps";
import { openUrl } from "@/stores/gh";
import { frameReport, grantFiles } from "./frameFiles";
import { framePath, keepPageScroll, pageScrollNote, pageScrollOf } from "./pageScroll";
import { isThemeAck, pageFrameNote, pageKey, pageOpenUrl, pageUnsupported, resizeHeight, themedUrl } from "./previewGrant";

/**
 * The sandbox of a frame with no owning thread (a File tab on an arbitrary HTML file):
 * scripts, forms, and the dialogs, downloads and popups the frame's script answers for
 * (a link to another site opens in the browser), and an opaque origin, so it cannot reach another page's frame (a thread's,
 * whose bridge it would otherwise drive through `parent.frames`) nor keep any storage
 * (docs/notes/bridge-fix-frames.md). Never `allow-top-navigation`, so a link cannot
 * replace the app.
 */
export const HTML_PREVIEW_SANDBOX = "allow-scripts allow-forms allow-popups allow-popups-to-escape-sandbox allow-modals allow-downloads";

/**
 * The sandbox of a page a thread showed: HTML_PREVIEW_SANDBOX and `allow-same-origin`, so
 * it has localStorage and IndexedDB (docs/notes/bridge-2-gui.md), for the app's session
 * only: WebKit never writes a cross-site frame's storage to disk, so cf.storage is the
 * daemon's (docs/notes/bridge-fix-storage.md). That origin is its grant's own on the
 * daemon's pages listener (`http://<grant>.localhost:<pages port>`,
 * docs/notes/page-preview-serving.md), never the app's and never the API's, whose CORS
 * refuses it: the page still cannot reach Code Foundry's window or the daemon's
 * authenticated routes, and reaches Code Foundry only through the bridge. Pages of one tree
 * share that origin, so two of them on screen can reach each other's window (accepted: both
 * are the user's own threads).
 */
export const THREAD_PAGE_SANDBOX = `${HTML_PREVIEW_SANDBOX} allow-same-origin`;

/**
 * How long a frame waits, after a new theme reached the daemon, for the page to answer
 * `cf:theme` with `{ type: "cf:theme:ack" }` before it reloads (docs/notes/inline-html-2-fixes.md).
 */
export const THEME_ACK_MS = 300;

/**
 * How long a frame stays hidden waiting for its `load` before it shows anyway: `load` waits
 * for every image and script, and a page held up by a slow one should still show what it has
 * (a thread's page is painted in the theme from its first byte, so it is not white then).
 */
export const FRAME_REVEAL_MS = 1000;

/** How long a frame waits after one of its document's files was written before it reloads the document, so a build writing several reloads it once. */
export const FILES_RELOAD_MS = 150;

/** The least time between two links a frame sends to the browser. */
export const OPEN_GAP_MS = 500;

/**
 * How long after a `load` a frame waits for its document's answer to `cf:ping` before it
 * takes the document for another site's.
 */
export const LEFT_WAIT_MS = 400;

/**
 * An HTML page in a sandboxed frame at a granted URL (usePreviewGrant). The File tab's
 * preview and a thread's inline page are this one frame (docs/notes/
 * html-preview-interactive.md, inline-html.md). A page that links `/cf/theme.css` paints in
 * the user's theme; the frame is also posted `{ type: "cf:theme", id, scheme, vars }` on
 * load and on every theme change (docs/notes/theme-css-route.md), to "*" as before the
 * bridge (a page holds nothing secret in it).
 *
 * Theme changes (inline-html-2-fixes.md):
 * - The iframe element's own `color-scheme` is the app's scheme, which WebKit hands the page
 *   as its `prefers-color-scheme` (live, without a reload), so a page with a
 *   `prefers-color-scheme` block follows the app, not macOS. Only the element's own value
 *   counts: the one it inherits from `<html>` does not.
 * - A page that applies `cf:theme` itself answers `{ type: "cf:theme:ack" }` and keeps its
 *   state. Once the daemon has a theme other than the one the frame loaded in
 *   (onThemePublished) and the page did not ack it, the frame is posted the theme again
 *   and reloads THEME_ACK_MS later unless an ack came meanwhile: a page that only links the
 *   stylesheet (fetched once, no-store) repaints, its state going with the reload.
 * - A page with no thread (an opaque frame, served as written) is reloaded only when its
 *   document said it uses the theme (`/cf/theme.css` or the bridge; the `theme` of its
 *   `cf:here`, frame.js): any other HTML file has nothing of the theme to repaint, and a reload
 *   would lose what the user did in it (docs/notes/page-frame-states.md). A thread's page is
 *   painted in the theme by the daemon, so it reloads as above.
 *
 * `onResize` hears this frame's own `{ type: "cf:resize", height }` messages (a page asking
 * for its height), in layout px. A page stays at 100% under the app's zoom.
 *
 * No white flash (docs/notes/inline-page-frame.md): the iframe is transparent over a
 * `bg-cf-surface` box (className and style size the box) and hidden until its `load`, or
 * FRAME_REVEAL_MS, a spinner on the surface meanwhile; then it fades in over 120 ms (at once
 * with reduced motion). Every load starts hidden again (a theme reload, a new owning thread;
 * the host's `key` for an edit). A thread's page is asked for with THEMED_PARAM, so the daemon
 * paints it in the theme from its first byte; an opaque frame's page (any other HTML file) is
 * served as written and, once shown, has a white canvas, as in a browser.
 *
 * The page's other files (`scope`, the directory its grant serves): the frame watches the
 * files under it its document said it loaded (stylesheets, scripts, data; frameFiles.ts),
 * and asks the document to reload itself (`{ type: "cf:reload" }`) FILES_RELOAD_MS after one
 * is written, so it stays on the file it is at. The page's own file is its host's to watch.
 *
 * The bridge (stores/bridgeHost.ts): a page loading `/cf/bridge.js` runs verbs and
 * subscribes to the app's state as `thread`, the thread it acts for (its owner); without one
 * it is in an opaque origin (HTML_PREVIEW_SANDBOX) and its bridge does what `page` says
 * (docs/notes/page-ownership-gui.md): the bridge without a thread once the user allowed the
 * page, its ready held while they are asked (`onAsk` hears a document that wants it), every
 * call refused otherwise. A change of `page` that a document already had its ready under
 * loads the frame again, so the page starts over under the new answer; a held ready just
 * goes out. The frame's src carries a nonce of its own in its query (lib/bridge.ts
 * withNonce; the fragment is the page's), which the script sends back on every message. Only this
 * frame's own window, at the origin its URL names ("null" without a thread), with that
 * nonce is heard; `cf:resize` and `cf:theme:ack` may come without one (a page without the
 * script), never with another. A frame navigated to another URL, another page's grant
 * included, loses the nonce and with it the bridge; the page's own way to another file
 * under its grant keeps it (bridge.js carries the nonce on). Replies go to that window and
 * origin. A change of owning thread reloads the frame (its sandbox changes with it).
 * `onKey` hears this frame's own `{ type: "cf:key", key: "Escape" }`, with its nonce only:
 * Escape the page left alone (the lightbox closes on it; docs/notes/page-library-fixes-b.md).
 * `onPageErrors` hears the errors the bridge answered the frame's document with
 * (lib/pageErrors.ts; deduped, the latest few), and [] again on each load and on unmount.
 *
 * What a frame cannot do (docs/notes/page-frame-links.md): the daemon writes a script into
 * every document the frame loads (internal/preview/frame.js), bridge or not. A link to
 * another site, and `window.open`, arrive as `{ type: "cf:open", url }` and open in the
 * browser (view.open.url) while the user is in the frame, at most one per OPEN_GAP_MS; an
 * `alert`, `confirm`, `prompt`, download or storage use (in an opaque frame, whose
 * storage frame.js keeps in memory) arrives as `cf:unsupported` and joins the page's errors.
 * Neither needs the nonce: a page that left for another document of its own keeps them.
 *
 * A page check (`check`; docs/notes/page-self-check.md) hears everything else too: the
 * frame's load, the document's answers with its height and the TSX loader's state, its script
 * errors (`cf:script-error`, which only a check reads), every bridge refusal (the app's, and
 * the bridge's own in the page: `cf:refused`) and the bridge's
 * calls (stores/bridgeHost.ts `check`), and it may ping the document itself.
 *
 * A frame that went to another site anyway (docs/notes/leftovers-pages.md): after each
 * `load` the frame posts `{ type: "cf:ping", seq }`, which the script in every document the
 * daemon serves answers `{ type: "cf:here", seq }`; a document says `cf:going` before it
 * goes on to one at its own origin. A load whose document answers nothing in LEFT_WAIT_MS,
 * with no `cf:going` before it, after a document of the page's answered, is another site's
 * (or anything else the frame cannot show as the page): the frame is covered by "This page
 * went to another site" and Reload, which loads the page again. The answer, not a message
 * the document sends as it starts, because the frame's `load` may come before that.
 *
 * Where the reader left the page (`scrollKey`, pageScroll.ts; docs/notes/pages-tab-polish.md):
 * a page behind another tab or space, or a card scrolled far away, is unloaded and loads afresh
 * when shown again. The page's own document reports its scroll (`cf:scroll`, frame.js), kept
 * under `scrollKey` while it is the page's file (not another file the page went on to), and the
 * first ping of each load of the frame hands it back; frame.js puts it back unless the page or
 * the user placed it first.
 */
export function HtmlFrame({
  url,
  name,
  className,
  style,
  onResize,
  testId,
  thread = null,
  storagePath = null,
  page,
  pagePath,
  onAsk,
  onStale,
  onPageErrors,
  onKey,
  check,
  scope = null,
  scrollKey = "",
}: {
  url: string;
  /** The directory the page's grant serves (none for a one-file grant): the files its document loaded under it are watched. */
  scope?: string | null;
  name: string;
  /** The thread the page acts for, whose verbs and state its bridge may use; null for none. */
  thread?: string | null;
  /**
   * The page file whose cf.storage a page acting for `thread` keeps (PageAccess.path, when the
   * daemon keeps storage per file; docs/notes/page-storage-per-file.md); null: the thread's own
   * (an older daemon). A change loads the page again under it.
   */
  storagePath?: string | null;
  /** What a page with no thread may do (usePageThread); absent: nothing, every call refused. */
  page?: PageBridge | undefined;
  /** The page's file, named in a confirmation of a page with no thread. */
  pagePath?: string;
  /** A document of a page that is asked about said hello: it wants Code Foundry. */
  onAsk?: () => void;
  /** The daemon refused a call because what the page acts under is no longer true (its answer changed, its thread is gone): read the grant again. */
  onStale?: () => void;
  className?: string;
  style?: CSSProperties;
  onResize?: (height: number) => void;
  /** The errors the page's bridge answered, for its strip (components/files/PageErrors.tsx). */
  onPageErrors?: (errors: readonly PageError[]) => void;
  /** Escape pressed in the page and not consumed there (its bridge forwards it). */
  onKey?: (key: "Escape") => void;
  /** A page check's tap (lib/pageCheck.ts): set for the frame's life, never changed. */
  check?: PageCheckTap;
  testId: string;
  /** The place and file the page's scroll is kept under (pageScrollKey); "" keeps none. */
  scrollKey?: string;
}) {
  const frameRef = useRef<HTMLIFrameElement>(null);
  const scheme = useActiveTheme().scheme;
  // The frame's load (its key): a reload is a new one.
  const [load, setLoad] = useState(0);
  // The slots the page shows: what it loaded in, or the last it acked.
  const shown = useRef(activeThemeSlots());
  // The slots of the last post, and the last ones the page acked.
  const posted = useRef<Readonly<Record<string, string>> | null>(null);
  const acked = useRef<Readonly<Record<string, string>> | null>(null);
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  // Whether the document in the frame said it uses the app's theme (its cf:here).
  const themed = useRef(false);
  const opaqueRef = useRef(thread === null);
  useEffect(() => {
    opaqueRef.current = thread === null;
  });
  const post = () => {
    const win = frameRef.current?.contentWindow;
    if (!win) return;
    posted.current = activeThemeSlots();
    win.postMessage(themeFrameMessage(), "*");
  };
  const postRef = useRef(post);
  useEffect(() => {
    postRef.current = post;
  });
  useEffect(() => {
    const stopSlots = subscribeThemeSlots(() => {
      postRef.current();
    });
    const stopPublished = onThemePublished(() => {
      const slots = activeThemeSlots();
      if (shown.current === slots) return;
      // A page served as written that does not use the theme: nothing to repaint, nothing to lose.
      if (acked.current === slots || (opaqueRef.current && !themed.current)) {
        shown.current = slots;
        return;
      }
      postRef.current();
      clearTimeout(timer.current);
      timer.current = setTimeout(() => {
        const now = activeThemeSlots();
        if (acked.current === now) {
          shown.current = now;
          return;
        }
        shown.current = now;
        acked.current = null;
        setLoad((n) => n + 1);
      }, THEME_ACK_MS);
    });
    return () => {
      stopSlots();
      stopPublished();
      clearTimeout(timer.current);
    };
  }, []);
  // The errors of the document now in the frame.
  const errors = useRef<readonly PageError[]>([]);
  const errorsRef = useRef(onPageErrors);
  useEffect(() => {
    errorsRef.current = onPageErrors;
  });
  const report = useCallback((list: readonly PageError[]) => {
    errors.current = list;
    errorsRef.current?.(list);
  }, []);
  useEffect(
    () => () => {
      if (errors.current.length > 0) report([]);
    },
    [report],
  );
  // The bridge's host for this frame: one per thread it acts for, storage and page; gone on unmount. A
  // page without a thread is in an opaque origin, which messages name "null" and a post
  // cannot target.
  const opaque = thread === null;
  const pageOrigin = useMemo(() => originOf(url), [url]);
  const origin = opaque ? "null" : pageOrigin;
  const target = opaque ? "*" : pageOrigin;
  const [nonce] = useState(frameNonce);
  const src = useMemo(() => withNonce(opaque ? url : themedUrl(url), nonce), [url, nonce, opaque]);
  // Whether a document of the page answered in this load of the frame, the last ping and the
  // last one answered, and whether a document said it went on to its own origin.
  const here = useRef({ seen: false, ping: 0, answered: 0, going: false });
  const leftTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  useEffect(
    () => () => {
      clearTimeout(leftTimer.current);
    },
    [],
  );
  // The files to watch, one per line ("" for none), and the scope the next report maps under.
  const [files, setFiles] = useState("");
  const scopeRef = useRef(scope);
  useEffect(() => {
    scopeRef.current = scope;
  });
  const host = useRef<BridgeHost | null>(null);
  const present = useRef<() => boolean>(() => false);
  const openedAt = useRef(Number.NEGATIVE_INFINITY);
  const nameRef = useRef(name);
  const pagePathRef = useRef(pagePath);
  const askRef = useRef(onAsk);
  const staleRef = useRef(onStale);
  useEffect(() => {
    nameRef.current = name;
    pagePathRef.current = pagePath;
    askRef.current = onAsk;
    staleRef.current = onStale;
  });
  // The page's access as one value an effect can follow (PageBridge is a fresh object each render).
  const access = page ? JSON.stringify(page) : "";
  const pageRef = useRef(page);
  useEffect(() => {
    pageRef.current = page;
  });
  useEffect(() => {
    const attention = watchFrameAttention(() => frameRef.current);
    const first = pageRef.current;
    const h = createBridgeHost({
      threadId: thread,
      ...(storagePath ? { storagePath } : {}),
      ...(first ? { page: first } : {}),
      get pageName() {
        return nameRef.current;
      },
      get pagePath() {
        return pagePathRef.current ?? "";
      },
      onAsk: () => askRef.current?.(),
      onStale: () => staleRef.current?.(),
      userPresent: attention.present,
      post: (msg) => {
        const win = frameRef.current?.contentWindow;
        if (win && target) win.postMessage(msg, target);
      },
      onError: (e) => {
        report(addPageError(errors.current, e));
        check?.problem({ kind: "bridge", call: e.call, code: e.code, message: e.message, where: "" });
      },
      ...(check ? { check } : {}),
    });
    host.current = h;
    present.current = attention.present;
    return () => {
      h.dispose();
      attention.stop();
      if (host.current === h) host.current = null;
    };
  }, [thread, storagePath, target, report, check]);
  // The user answered (or the grant changed): the host is told; a document that had its ready loads again.
  useEffect(() => {
    const p = pageRef.current;
    if (!p || !host.current) return;
    if (host.current.setPage(p)) setLoad((n) => n + 1);
  }, [access]);
  const resizeRef = useRef(onResize);
  const keyRef = useRef(onKey);
  const scrollKeyRef = useRef(scrollKey);
  useEffect(() => {
    resizeRef.current = onResize;
    keyRef.current = onKey;
    scrollKeyRef.current = scrollKey;
  });
  useEffect(() => {
    const onMessage = (e: MessageEvent) => {
      const win = frameRef.current?.contentWindow;
      if (!win || e.source !== win || !origin || e.origin !== origin) return;
      if (isThemeAck(e.data)) {
        if (nonceMatches(e.data, nonce, true)) acked.current = posted.current;
        return;
      }
      const h = resizeHeight(e.data);
      if (h !== null) {
        // The page measures at scale 1 (the frame undoes the zoom); the box's height is in layout px.
        if (nonceMatches(e.data, nonce, true)) {
          resizeRef.current?.(h / zoomFactor());
          check?.resize(h);
        }
        return;
      }
      const link = pageOpenUrl(e.data);
      if (link !== null) {
        const now = performance.now();
        if (!present.current() || now - openedAt.current < OPEN_GAP_MS) return;
        openedAt.current = now;
        void openUrl(link);
        return;
      }
      const cannot = pageUnsupported(e.data, opaque);
      if (cannot !== null) {
        report(addPageError(errors.current, { ...cannot, code: "unavailable", atMs: Date.now() }));
        check?.problem({ kind: "unsupported", call: cannot.call, code: "", message: cannot.message, where: "" });
        return;
      }
      // A check's alone: the page's own errors and the loader's end (internal/preview/frame.js).
      const scriptError = scriptErrorOf(e.data);
      if (scriptError) {
        check?.problem(scriptError);
        return;
      }
      const shape = frameShapeOf(e.data);
      if (shape && check) check.note(shape);
      // A call the page's bridge refused itself (no click, say): the strip leaves those to the page.
      const refusal = pageRefusalOf(e.data);
      if (refusal) {
        if (nonceMatches(e.data, nonce)) check?.problem(refusal);
        return;
      }
      const at = pageScrollNote(e.data);
      if (at) {
        // The page's own file only: a file it went on to is not where the frame loads it.
        if (scrollKeyRef.current && at.path === framePath(url)) keepPageScroll(scrollKeyRef.current, at);
        return;
      }
      const doc = frameReport(e.data);
      if (doc) {
        themed.current = doc.theme;
        setFiles(scopeRef.current ? grantFiles(url, scopeRef.current, doc.files).join("\n") : "");
      }
      const note = pageFrameNote(e.data);
      if (note) {
        const h = here.current;
        if (note.note === "going") h.going = true;
        else if (note.seq === h.ping) here.current = { ...h, seen: true, answered: note.seq, going: false };
        return;
      }
      const key = pageKey(e.data);
      if (key !== null) {
        if (nonceMatches(e.data, nonce)) keyRef.current?.(key);
        return;
      }
      if (nonceMatches(e.data, nonce)) host.current?.receive(e.data);
    };
    window.addEventListener("message", onMessage);
    return () => {
      window.removeEventListener("message", onMessage);
    };
  }, [origin, nonce, report, opaque, url, check]);
  // A check pings the document itself, for its height once the page is quiet.
  useEffect(() => {
    if (!check) return;
    return check.attach((seq) => {
      if (target) frameRef.current?.contentWindow?.postMessage({ type: "cf:ping", seq }, target);
    });
  }, [check, target]);
  // The files the document said it loaded, watched: one written reloads the document in place.
  useEffect(() => {
    if (!files) return;
    let t: ReturnType<typeof setTimeout> | undefined;
    const reload = () => {
      clearTimeout(t);
      t = setTimeout(() => {
        const win = frameRef.current?.contentWindow;
        if (win && target) win.postMessage({ type: "cf:reload" }, target);
      }, FILES_RELOAD_MS);
    };
    const stops = files.split("\n").map((f) => fileWatcher.watch(f, reload));
    return () => {
      clearTimeout(t);
      for (const stop of stops) stop();
    };
  }, [files, target]);
  // The frame's load: visible once its `load` came (or FRAME_REVEAL_MS passed). A new grant's
  // URL for the same frame (a daemon restart) keeps it visible: that page is up.
  const frameKey = `${String(load)}:${thread ?? ""}:${storagePath ?? ""}`;
  const [visibleKey, setVisibleKey] = useState<string | null>(null);
  // The frame load whose document went to another site.
  const [leftKey, setLeftKey] = useState<string | null>(null);
  const left = leftKey === frameKey;
  const frameKeyRef = useRef(frameKey);
  useEffect(() => {
    frameKeyRef.current = frameKey;
    here.current = { seen: false, ping: 0, answered: 0, going: false };
    clearTimeout(leftTimer.current);
  }, [frameKey]);
  // The frame load whose ping handed the page its scroll: only the first load of each (a page's
  // own way back to its file starts at the top, as in a browser).
  const scrolledFor = useRef<string | null>(null);
  const loaded = () => {
    const seq = here.current.ping + 1;
    here.current.ping = seq;
    const key = frameKey;
    const at = scrolledFor.current !== key && scrollKey ? pageScrollOf(scrollKey) : null;
    scrolledFor.current = key;
    if (target) frameRef.current?.contentWindow?.postMessage({ type: "cf:ping", seq, ...(at ? { scroll: { ...at, path: framePath(url) } } : {}) }, target);
    clearTimeout(leftTimer.current);
    leftTimer.current = setTimeout(() => {
      const h = here.current;
      const excused = h.going;
      h.going = false;
      if (h.ping !== seq || h.answered === seq || !h.seen || excused || frameKeyRef.current !== key) return;
      setLeftKey(key);
    }, LEFT_WAIT_MS);
  };
  const visible = visibleKey === frameKey;
  useEffect(() => {
    if (visible) return;
    const t = setTimeout(() => {
      setVisibleKey(frameKey);
    }, FRAME_REVEAL_MS);
    return () => {
      clearTimeout(t);
    };
  }, [frameKey, visible]);
  return (
    <div className={cn("relative w-full bg-cf-surface", className)} style={style} data-testid={`${testId}-box`}>
      <iframe
        key={frameKey}
        ref={frameRef}
        onLoad={() => {
          themed.current = false;
          setVisibleKey(frameKey);
          post();
          if (errors.current.length > 0) report([]);
          host.current?.loaded();
          loaded();
          check?.loaded();
        }}
        aria-label={`${name} (rendered)`}
        src={src}
        sandbox={opaque ? HTML_PREVIEW_SANDBOX : THREAD_PAGE_SANDBOX}
        allow="clipboard-write"
        referrerPolicy="no-referrer"
        // Transparent: the box's surface shows until the page paints, and behind a thread's
        // page with no background. An opaque frame's page turns white once shown, as in a browser.
        // The page zoom undone on the frame: the system WKWebView scales a frame's document again
        // under zoom on <html>, leaving a white strip below 100% and a clipped page above it. It
        // must be there before the frame loads. docs/notes/frame-page-zoom.md.
        className={cn("absolute inset-0 size-full border-0 [zoom:calc(1/var(--cf-zoom))] transition-opacity duration-120 ease-out motion-reduce:transition-none", visible ? "opacity-100" : "opacity-0", visible && opaque && "bg-white")}
        style={{ colorScheme: scheme }}
        data-testid={testId}
        data-load={load}
        data-shown={visible || undefined}
      />
      {left && (
        <div className="absolute inset-0 flex flex-col items-center justify-center gap-3 bg-cf-surface p-4 text-center" role="status" data-testid={`${testId}-left`}>
          <p className="text-body font-medium">This page went to another site</p>
          <Button
            variant="outline"
            size="sm"
            onClick={() => {
              setLoad((n) => n + 1);
            }}
            data-testid={`${testId}-left-reload`}
          >
            <RotateCw />
            Reload
          </Button>
        </div>
      )}
      {!visible && (
        <div className="pointer-events-none absolute inset-0 flex items-center justify-center text-cf-text-muted" data-testid={`${testId}-loading`}>
          <LoaderCircle className="size-4 animate-spin" aria-label="Loading" />
        </div>
      )}
    </div>
  );
}

/** The origin a frame URL names; null for one that does not parse. */
function originOf(url: string): string | null {
  try {
    return new URL(url).origin;
  } catch {
    return null;
  }
}
