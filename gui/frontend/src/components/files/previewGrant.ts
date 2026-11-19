import { useEffect, useState } from "react";
import { previewFile, type FilePreview } from "@/api/files";
import { errorMessage, isAbort } from "@/api/stream";
import { useHealthStore } from "@/stores/health";
import { pageChanges, usePageAnswers } from "@/stores/pageAnswers";

/** A page's height request, `{ type: "cf:resize", height }` (CSS px, positive); null for any other message. */
export function resizeHeight(data: unknown): number | null {
  if (typeof data !== "object" || data === null) return null;
  const m = data as { type?: unknown; height?: unknown };
  if (m.type !== "cf:resize" || typeof m.height !== "number" || !Number.isFinite(m.height) || m.height <= 0) return null;
  return m.height;
}

/**
 * The key a page's bridge forwards, `{ type: "cf:key", key: "Escape" }`: Escape pressed in the
 * page that nothing there consumed (docs/notes/page-library-fixes-b.md); null for any other message.
 */
export function pageKey(data: unknown): "Escape" | null {
  if (typeof data !== "object" || data === null) return null;
  const m = data as { type?: unknown; key?: unknown };
  return m.type === "cf:key" && m.key === "Escape" ? "Escape" : null;
}

/** The longest URL a page may ask the browser to open. */
const OPEN_URL_MAX = 2048;

/**
 * A link the page's frame script sends to the browser, `{ type: "cf:open", url }` (internal/
 * preview/frame.js): the http(s) URL, or null for any other message.
 */
export function pageOpenUrl(data: unknown): string | null {
  if (typeof data !== "object" || data === null) return null;
  const m = data as { type?: unknown; url?: unknown };
  if (m.type !== "cf:open" || typeof m.url !== "string" || m.url.length > OPEN_URL_MAX) return null;
  try {
    const u = new URL(m.url);
    return u.protocol === "http:" || u.protocol === "https:" ? u.href : null;
  } catch {
    return null;
  }
}

/** What a frame cannot do for a page (internal/preview/frame.js). */
export type PageUnsupported = "alert" | "confirm" | "prompt" | "download" | "form" | "navigation" | "storage";

const UNSUPPORTED: Readonly<Record<PageUnsupported, { call: string; message: string }>> = {
  alert: { call: "alert()", message: "alert() shows nothing in a page here: show the message in the page itself" },
  confirm: { call: "confirm()", message: "confirm() shows nothing in a page here and answers false: ask with a dialog in the page itself" },
  prompt: { call: "prompt()", message: "prompt() shows nothing in a page here and answers null: ask with a field in the page itself" },
  download: {
    call: "download",
    message: 'a download saves nothing in a page here: in the click\'s handler, save the file into the thread\'s checkout with cf.run("file.export", { path, text }) (base64 for bytes) and show the path it answers',
  },
  form: {
    call: "form",
    message: "a form sent to another site goes nowhere from a page here (a GET opens in the browser only from the user's press): send it with cf.fetch in the submit handler and call preventDefault",
  },
  navigation: {
    call: "location",
    message: "a page here cannot send its frame to another site, which could not sign in: link to it, and the user's click opens it in the browser",
  },
  storage: {
    call: "storage",
    message: "a page no thread showed has no storage here: what it keeps lasts until it reloads. Open the file in a browser to keep its data; a page made for Code Foundry keeps it with cf.storage (/cf/bridge.js)",
  },
};

/**
 * What differs for a page with no thread (a File tab's opaque frame; docs/notes/page-frame-states.md):
 * it has no checkout to export into, and was likely not written for Code Foundry at all.
 */
const THREADLESS: Readonly<Partial<Record<PageUnsupported, { call: string; message: string }>>> = {
  download: { call: "download", message: "a download saves nothing from a page in a File tab: open the file in a browser to download from it" },
};

/** The storage APIs frame.js names in a `storage` report, each its own entry on the strip. */
const STORAGE_CALLS: ReadonlySet<string> = new Set(["localStorage", "sessionStorage", "document.cookie", "indexedDB"]);

/** What the strip says of indexedDB, which frame.js cannot keep in memory: it still fails. */
const INDEXED_DB = "indexedDB fails in a page no thread showed (it has no storage here). Open the file in a browser to keep its data; a page made for Code Foundry keeps it with cf.storage (/cf/bridge.js)";

/**
 * A call the frame could not make for the page, `{ type: "cf:unsupported", what, text }`, as
 * the page's strip reports it (lib/pageErrors.ts); null for any other message. `threadless`:
 * the frame shows a page with no thread, which has no checkout to save a download into.
 */
export function pageUnsupported(data: unknown, threadless = false): { call: string; message: string } | null {
  if (typeof data !== "object" || data === null) return null;
  const m = data as { type?: unknown; what?: unknown; text?: unknown };
  if (m.type !== "cf:unsupported" || typeof m.what !== "string" || !Object.hasOwn(UNSUPPORTED, m.what)) return null;
  const what = m.what as PageUnsupported;
  if (what === "storage" && typeof m.text === "string" && STORAGE_CALLS.has(m.text)) {
    return { call: m.text, message: m.text === "indexedDB" ? INDEXED_DB : UNSUPPORTED.storage.message };
  }
  return (threadless ? THREADLESS[what] : undefined) ?? UNSUPPORTED[what];
}

/** What a document's frame script says of it (internal/preview/frame.js). */
export type PageFrameNote = { note: "here"; seq: number } | { note: "going" };

/**
 * `cf:here` (its answer to the frame's `cf:ping` of that seq) or `cf:going` (it goes on to a
 * document at its own origin); null for any other message.
 */
export function pageFrameNote(data: unknown): PageFrameNote | null {
  if (typeof data !== "object" || data === null) return null;
  const m = data as { type?: unknown; seq?: unknown };
  if (m.type === "cf:going") return { note: "going" };
  return m.type === "cf:here" && typeof m.seq === "number" ? { note: "here", seq: m.seq } : null;
}

/** A page's answer to `cf:theme`, `{ type: "cf:theme:ack" }`: it applied the theme itself, so its frame need not reload. */
export function isThemeAck(data: unknown): boolean {
  return typeof data === "object" && data !== null && (data as { type?: unknown }).type === "cf:theme:ack";
}

/**
 * The query parameter that asks the daemon to paint a page in the app's theme from its first
 * byte (internal/preview paint.go ThemedParam): a colour-scheme meta and the surface as its
 * background, ahead of everything in its head (docs/notes/inline-page-frame.md).
 */
export const THEMED_PARAM = "cf-page";

/** A grant URL with THEMED_PARAM set, for a frame that shows a thread's page; the URL as given when it does not parse. */
export function themedUrl(url: string): string {
  try {
    const u = new URL(url);
    u.searchParams.set(THEMED_PARAM, "1");
    return u.toString();
  } catch {
    return url;
  }
}

/** A grant for one file: loading (no preview, no error yet), the grant, or why there is none. */
export interface PreviewGrant {
  preview: FilePreview | null;
  error: string | null;
  loading: boolean;
  retry: () => void;
}

/**
 * Asks the daemon once per (baseDir, path) for a URL serving the file and what it may load
 * (FilesystemService.PreviewFile): `path` absolute, or relative to `baseDir`. Again when the
 * daemon restarts (its pid changes): grants die with it, and a frame reloading on a dead one
 * (a theme switch, an edit) would come back blank. Again when the daemon's word about the page
 * changed (stores/pageAnswers.ts: its owner or the user's answer, from any window or the CLI,
 * its owner removed, or the event stream connected again): the grant carries it
 * (FilePreview.page; docs/notes/page-access-live.md). Again on `retry` (Retry, the tab's
 * Refresh, an edit of the file, a call the daemon refused as the page's access changed). The
 * grant's URL is the daemon's one per file, so reading it again reloads nothing by itself; the
 * last grant stays until the new one arrives, so a frame that is up does not flash.
 */
export function usePreviewGrant(baseDir: string, path: string): PreviewGrant {
  const key = `${baseDir}\u0000${path}`;
  const [state, setState] = useState<{ key: string; preview: FilePreview | null; error: string | null }>({ key: "", preview: null, error: null });
  const [attempt, setAttempt] = useState(0);
  // A new daemon (another pid; not the same one back after a blip) asks again.
  const daemon = useHealthStore((s) => (s.status === "ok" ? (s.health?.pid ?? null) : null));
  const [epoch, setEpoch] = useState({ pid: daemon, n: 0 });
  if (daemon !== null && daemon !== epoch.pid) setEpoch({ pid: daemon, n: epoch.n + 1 });
  const current = state.key === key ? state : null;
  // A change to this page since its grant came asks again; one before it does not.
  const page = current?.preview?.page;
  const pagePath = page?.path ?? "";
  const owner = page?.consent === "owned" ? page.ownerThread : "";
  const changes = usePageAnswers((s) => pageChanges(s, pagePath, owner));
  const followed = `${pagePath}\u0000${owner}`;
  const [seen, setSeen] = useState({ followed: "", n: 0 });
  if (followed !== seen.followed) setSeen({ followed, n: changes });
  else if (changes !== seen.n) {
    setSeen({ followed, n: changes });
    setAttempt(attempt + 1);
  }
  useEffect(() => {
    const c = new AbortController();
    previewFile(baseDir, path, undefined, c.signal).then(
      (preview) => {
        if (!c.signal.aborted) setState({ key, preview, error: null });
      },
      (err: unknown) => {
        if (!isAbort(err) && !c.signal.aborted) setState({ key, preview: null, error: errorMessage(err) });
      },
    );
    return () => {
      c.abort();
    };
  }, [baseDir, path, key, attempt, epoch.n]);
  return {
    preview: current?.preview ?? null,
    error: current?.error ?? null,
    loading: current === null,
    retry: () => {
      setAttempt((n) => n + 1);
    },
  };
}
