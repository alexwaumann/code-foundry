/**
 * PageService (docs/notes/page-ownership-daemon.md): who owns an HTML page file and whether
 * the user allowed a page no thread owns, and cf.storage and cf.fetch for such a page (the
 * bridge without a thread, docs/notes/page-ownership-gui.md). The daemon is the authority:
 * the GUI never reads a thread's log to decide which thread a page acts for. The user's
 * answer changes only through the page.allow and page.disallow commands; nothing here
 * changes it. A page's own reads and writes, not user actions: no command.
 */
import { PageAccessSchema, PageConsent, PageOwnerSource, PageService, type PageAccess, type PageEvent } from "@/gen/codefoundry/v1/page_pb";
import { ConnectError } from "@connectrpc/connect";
import { daemon, type DaemonConnection } from "./endpoint";
import type { PageStorageValues } from "./pageStorage";
import type { ProxyFetchAnswer, ProxyFetchCall } from "./proxyFetch";

/** What a page may do with the bridge: a thread's own, allowed without one, refused, not asked yet, or never (not a page). */
export type PageConsentView = "owned" | "allowed" | "refused" | "not-asked" | "unavailable";

/** How its owner came to own a page; "" for no owner. */
export type PageOwnerSourceView = "shown" | "written" | "pages-directory" | "";

/** One thread that owns a page (PageOwner). */
export interface PageOwnerView {
  thread: string;
  source: Exclude<PageOwnerSourceView, "">;
}

/** PageAccess: what the daemon says about one page file. */
export interface PageAccessView {
  /** The file's resolved absolute path: what storage, fetch and the page.* commands are sent. "" with `unavailable`. */
  path: string;
  /** The page's first owner: the thread it acts for where no owner of its own is given (a File tab of another thread); "" for none. */
  ownerThread: string;
  ownerSource: PageOwnerSourceView;
  /**
   * Every thread that owns the page, the first first (docs/notes/page-storage-per-file.md). From
   * a daemon older than many owners: the owner alone.
   */
  owners: readonly PageOwnerView[];
  /** The page keeps cf.storage for its file (PageService) whichever thread it acts for; false from an older daemon (a thread's page keeps its thread's). */
  storagePerFile: boolean;
  consent: PageConsentView;
  /** The user's own answer, kept while a thread owns the page too. */
  answer: Exclude<PageConsentView, "owned">;
  /** Why the page is `unavailable`, for a notice. */
  unavailableReason: string;
}

const CONSENT: Readonly<Record<PageConsent, PageConsentView | null>> = {
  [PageConsent.UNSPECIFIED]: null,
  [PageConsent.OWNED]: "owned",
  [PageConsent.ALLOWED]: "allowed",
  [PageConsent.REFUSED]: "refused",
  [PageConsent.NOT_ASKED]: "not-asked",
  [PageConsent.UNAVAILABLE]: "unavailable",
};

const SOURCE: Readonly<Record<PageOwnerSource, PageOwnerSourceView>> = {
  [PageOwnerSource.UNSPECIFIED]: "",
  [PageOwnerSource.SHOWN]: "shown",
  [PageOwnerSource.WRITTEN]: "written",
  [PageOwnerSource.PAGES_DIRECTORY]: "pages-directory",
};

/** A PageAccess as the GUI reads it; null for none or an unset consent (a daemon from before ownership). */
export function toPageAccessView(p: PageAccess | undefined): PageAccessView | null {
  const consent = p ? CONSENT[p.consent] : null;
  if (!p || !consent) return null;
  const answer = CONSENT[p.answer];
  const owners = p.owners.flatMap((o) => {
    const source = SOURCE[o.source];
    return o.threadId && source ? [{ thread: o.threadId, source }] : [];
  });
  const ownerSource = SOURCE[p.ownerSource];
  return {
    path: p.path,
    ownerThread: p.ownerThread,
    ownerSource,
    owners: owners.length > 0 || !p.ownerThread ? owners : [{ thread: p.ownerThread, source: ownerSource || "shown" }],
    storagePerFile: p.storagePerFile,
    consent,
    answer: answer === null || answer === "owned" ? "not-asked" : answer,
    unavailableReason: p.unavailableReason,
  };
}

/**
 * EventService's page source (docs/notes/page-access-live.md): which pages to read again,
 * never their answer. `paths` changed owner or answer; `removedThread`'s pages lost their
 * owner; `all`: any page may have (on connect, after missed events).
 */
export interface PageEventView {
  paths: readonly string[];
  removedThread: string;
  all: boolean;
  /** Pages whose cf.storage a write changed, from any client (docs/notes/page-storage-change-event.md). */
  storagePaths: readonly string[];
}

export function toPageEventView(e: PageEvent): PageEventView {
  return { paths: [...e.paths], removedThread: e.removedThread, all: e.all, storagePaths: [...e.storagePaths] };
}

/**
 * The daemon's refusal of a command from a page no thread owns that may not use Code Foundry
 * now (Invoke's PermissionDenied with a PageAccess detail): the page's access then; null for
 * any other error.
 */
export function refusedPageOf(err: unknown): PageAccessView | null {
  if (!(err instanceof ConnectError)) return null;
  const [d] = err.findDetails(PageAccessSchema);
  return d ? toPageAccessView(d) : null;
}

const CONSENTS: readonly string[] = ["owned", "allowed", "refused", "not-asked", "unavailable"];
const SOURCES: readonly string[] = ["shown", "written", "pages-directory", ""];

/**
 * The JSON page.get, page.allow and page.disallow answer (command.PageView), as a
 * PageAccessView; null for anything else.
 */
export function pageAccessFromJson(json: string): PageAccessView | null {
  let v: unknown;
  try {
    v = JSON.parse(json);
  } catch {
    return null;
  }
  if (typeof v !== "object" || v === null) return null;
  const o = v as Record<string, unknown>;
  const str = (k: string) => (typeof o[k] === "string" ? o[k] : "");
  const consent = str("consent");
  const answer = str("answer");
  const source = str("owner_source");
  if (str("path") === "" || !CONSENTS.includes(consent)) return null;
  const ownerSource = (SOURCES.includes(source) ? source : "") as PageOwnerSourceView;
  const owners = (Array.isArray(o.owners) ? (o.owners as unknown[]) : []).flatMap((x): PageOwnerView[] => {
    if (typeof x !== "object" || x === null) return [];
    const { thread, source: s } = x as Record<string, unknown>;
    return typeof thread === "string" && thread !== "" && typeof s === "string" && s !== "" && SOURCES.includes(s) ? [{ thread, source: s as PageOwnerView["source"] }] : [];
  });
  const owner = str("owner_thread");
  return {
    path: str("path"),
    ownerThread: owner,
    ownerSource,
    owners: owners.length > 0 || !owner ? owners : [{ thread: owner, source: ownerSource || "shown" }],
    // The commands' JSON does not say; the grant (PreviewFile) does, and is what a frame reads.
    storagePerFile: false,
    consent: consent as PageConsentView,
    answer: (answer === "allowed" || answer === "refused" ? answer : "not-asked") as PageAccessView["answer"],
    unavailableReason: "",
  };
}

/** PageService.PageStorage: the whole storage of a page file, whichever thread it acts for. */
export async function getPageFileStorage(path: string, conn: DaemonConnection = daemon): Promise<PageStorageValues> {
  const c = await conn.client(PageService);
  const res = await c.pageStorage({ path });
  return { ...res.values };
}

/** PageService.SetPageStorage: sets key to value's JSON text, or removes it (null); the storage after. */
export async function setPageFileStorage(path: string, key: string, value: string | null, conn: DaemonConnection = daemon): Promise<PageStorageValues> {
  const c = await conn.client(PageService);
  const res = await c.setPageStorage(value === null ? { path, key } : { path, key, value });
  return { ...res.values };
}

/** How long past the request's own timeout the call waits for the daemon to say so (as api/proxyFetch.ts). */
const ANSWER_GRACE_MS = 3000;

/** PageService.ProxyFetch: cf.fetch for a page no thread owns; aborting `signal` aborts the request in the daemon. */
export async function proxyPageFetch(path: string, call: ProxyFetchCall, opts: { signal?: AbortSignal } = {}, conn: DaemonConnection = daemon): Promise<ProxyFetchAnswer> {
  const c = await conn.client(PageService);
  const res = await c.proxyFetch(
    { path, url: call.url, method: call.method, headers: call.headers, body: new TextEncoder().encode(call.body), timeoutMs: call.timeoutMs },
    { signal: opts.signal, timeoutMs: call.timeoutMs + ANSWER_GRACE_MS },
  );
  return { status: res.status, statusText: res.statusText, headers: { ...res.headers }, body: new TextDecoder().decode(res.body), url: res.url };
}
