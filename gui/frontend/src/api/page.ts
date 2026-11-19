/**
 * PageService (docs/notes/page-ownership-daemon.md): who owns an HTML page file and whether
 * the user allowed a page no thread owns, and cf.storage and cf.fetch for such a page (the
 * bridge without a thread, docs/notes/page-ownership-gui.md). The daemon is the authority:
 * the GUI never reads a thread's log to decide which thread a page acts for. The user's
 * answer changes only through the page.allow and page.disallow commands; nothing here
 * changes it. A page's own reads and writes, not user actions: no command.
 */
import { PageConsent, PageOwnerSource, PageService, type PageAccess } from "@/gen/codefoundry/v1/page_pb";
import { daemon, type DaemonConnection } from "./endpoint";
import type { PageStorageValues } from "./pageStorage";
import type { ProxyFetchAnswer, ProxyFetchCall } from "./proxyFetch";

/** What a page may do with the bridge: a thread's own, allowed without one, refused, not asked yet, or never (not a page). */
export type PageConsentView = "owned" | "allowed" | "refused" | "not-asked" | "unavailable";

/** How its owner came to own a page; "" for no owner. */
export type PageOwnerSourceView = "shown" | "written" | "pages-directory" | "";

/** PageAccess: what the daemon says about one page file. */
export interface PageAccessView {
  /** The file's resolved absolute path: what storage, fetch and the page.* commands are sent. "" with `unavailable`. */
  path: string;
  /** The thread whose bridge the page gets, whatever tab shows it; "" for none. */
  ownerThread: string;
  ownerSource: PageOwnerSourceView;
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
  return {
    path: p.path,
    ownerThread: p.ownerThread,
    ownerSource: SOURCE[p.ownerSource],
    consent,
    answer: answer === null || answer === "owned" ? "not-asked" : answer,
    unavailableReason: p.unavailableReason,
  };
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
  return {
    path: str("path"),
    ownerThread: str("owner_thread"),
    ownerSource: (SOURCES.includes(source) ? source : "") as PageOwnerSourceView,
    consent: consent as PageConsentView,
    answer: (answer === "allowed" || answer === "refused" ? answer : "not-asked") as PageAccessView["answer"],
    unavailableReason: "",
  };
}

/** PageService.PageStorage: the whole storage of a page no thread owns. */
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
