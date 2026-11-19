/**
 * PageService and the page.* commands (docs/notes/page-ownership-daemon.md), as the GUI half
 * reads them (docs/notes/page-ownership-gui.md): who owns each page file and the user's answer
 * for a page no thread owns, with its storage and fetch.
 *
 * The owner is the thread that last showed the file (an html item in its log: view.inline, a
 * scripted thread's card) or opened it with view.open.page, latest wins; a file in a thread's
 * pages directory (~/.code-foundry/pages/<id>/) is that thread's otherwise. Tests script the
 * rest with POST /__mock/page (mock/server.ts): an owner (`owner=s-1&how=written`), an answer
 * (`consent=allowed|refused|not-asked`), a file that is no page (`unavailable=<reason>`).
 * Paths are resolved through the mock's links (POST /__mock/fs/link), as the daemon follows
 * symlinks. Consent is enforced here as there: storage, fetch and a command naming a page
 * (UiContext.page_path) for a page not allowed are refused whatever the GUI sends. A new
 * owner or answer is published on the page source (docs/notes/page-access-live.md); world.ts
 * publishes a removed thread there too.
 */
import { Code, ConnectError } from "@connectrpc/connect";
import type { MessageInitShape } from "@bufbuild/protobuf";
import { ArgType, CallOrigin, type UiContext } from "../src/gen/codefoundry/v1/command_pb";
import { create } from "@bufbuild/protobuf";
import { PageAccessSchema, PageConsent, PageOwnerSource, type PageEventSchema } from "../src/gen/codefoundry/v1/page_pb";
import { HOME } from "./filesystem";

type PageAccessInit = MessageInitShape<typeof PageAccessSchema>;
type PageEventInit = MessageInitShape<typeof PageEventSchema>;

/** The pages root: each thread's pages directory is under it, the welcome page directly in it. */
export const PAGES_ROOT = `${HOME}/.code-foundry/pages`;

/** What the mock needs from the rest of the world. */
export interface PageWorld {
  /** The path as the daemon resolves it (links followed); undefined when nothing is there. */
  resolve: (path: string) => string | undefined;
  /** The thread whose log last showed the file, and when (ms); null for none. */
  lastShown: (abs: string) => { threadId: string; at: number } | null;
  threadExists: (id: string) => boolean;
}

type How = "shown" | "written";
type Answer = "allowed" | "refused";

const MAX = 256 << 10;

export class MockPages {
  world: PageWorld | null = null;
  /** Owners recorded by view.open.page and scripted by tests, with when (ms). */
  private owners = new Map<string, { thread: string; how: How; at: number }>();
  private answers = new Map<string, Answer>();
  private unavailable = new Map<string, string>();
  private storage = new Map<string, Record<string, string>>();
  /** page.allow / page.disallow calls, for tests: "allow /path". */
  calls: string[] = [];
  /** The EventService page source (world.ts sets it). */
  publish: (e: PageEventInit) => void = () => undefined;

  reset(): void {
    this.owners.clear();
    this.answers.clear();
    this.unavailable.clear();
    this.storage.clear();
    this.calls = [];
  }

  /** The page's path resolved, or why it is no page (a ConnectError the RPCs throw). */
  private resolved(path: string): string {
    let abs = path.startsWith("~/") ? HOME + path.slice(1) : path;
    if (!abs.startsWith("/")) throw new ConnectError(`${path} is not an absolute path`, Code.InvalidArgument);
    const why = this.unavailable.get(abs);
    if (why !== undefined) throw new ConnectError(why, Code.InvalidArgument);
    if (!/\.html?$/i.test(abs)) throw new ConnectError(`${abs} is not an .html or .htm file`, Code.InvalidArgument);
    if (!abs.startsWith(`${HOME}/`)) throw new ConnectError(`${abs} is not under your home folder`, Code.InvalidArgument);
    const real = this.world?.resolve(abs);
    if (real === undefined) throw new ConnectError(`${abs} does not exist`, Code.NotFound);
    abs = real;
    return abs;
  }

  /** The thread that owns the resolved page and how, or null. */
  private owner(abs: string): { thread: string; how: How | "pages-directory" } | null {
    const exists = (id: string) => this.world?.threadExists(id) ?? true;
    const rec = this.owners.get(abs);
    const shown = this.world?.lastShown(abs) ?? null;
    const latest = rec && (!shown || rec.at >= shown.at) ? { thread: rec.thread, how: rec.how } : shown ? { thread: shown.threadId, how: "shown" as How } : null;
    if (latest && exists(latest.thread)) return latest;
    const m = new RegExp(`^${PAGES_ROOT.replace(/[.]/g, "\\.")}/([^/]+)/`).exec(abs);
    if (m?.[1] && exists(m[1])) return { thread: m[1], how: "pages-directory" };
    return null;
  }

  /** PageAccess for a resolved page. */
  private accessOf(abs: string): PageAccessInit {
    const own = this.owner(abs);
    const answer = this.answers.get(abs);
    const answered = answer === "allowed" ? PageConsent.ALLOWED : answer === "refused" ? PageConsent.REFUSED : PageConsent.NOT_ASKED;
    const source = own?.how === "shown" ? PageOwnerSource.SHOWN : own?.how === "written" ? PageOwnerSource.WRITTEN : own ? PageOwnerSource.PAGES_DIRECTORY : PageOwnerSource.UNSPECIFIED;
    return { path: abs, ownerThread: own?.thread ?? "", ownerSource: source, consent: own ? PageConsent.OWNED : answered, answer: answered };
  }

  /** PreviewFileResponse.page: never an error; a file that is no page is UNAVAILABLE with why. */
  previewPage(abs: string): PageAccessInit {
    try {
      return this.accessOf(this.resolved(abs));
    } catch (err) {
      return { consent: PageConsent.UNAVAILABLE, answer: PageConsent.UNAVAILABLE, unavailableReason: err instanceof Error ? err.message : String(err) };
    }
  }

  getPage(path: string): { page: PageAccessInit } {
    return { page: this.accessOf(this.resolved(path)) };
  }

  /** The page's storage key once the user allowed it (or a thread owns it); the daemon's consent errors otherwise. */
  private allowed(path: string): string {
    const abs = this.resolved(path);
    if (this.owner(abs)) return abs;
    const a = this.answers.get(abs);
    if (a === "refused") throw new ConnectError("the user did not allow this page", Code.PermissionDenied);
    if (a !== "allowed") throw new ConnectError("the user has not answered for this page yet", Code.FailedPrecondition);
    return abs;
  }

  pageStorage(path: string): { values: Record<string, string> } {
    return { values: { ...this.storage.get(this.allowed(path)) } };
  }

  setPageStorage(path: string, key: string, value: string | undefined): { values: Record<string, string> } {
    const abs = this.allowed(path);
    if (key === "") throw new ConnectError("page storage needs a key", Code.InvalidArgument);
    let vals = { ...this.storage.get(abs) };
    if (value === undefined) vals = Object.fromEntries(Object.entries(vals).filter(([k]) => k !== key));
    else {
      try {
        JSON.parse(value);
      } catch {
        throw new ConnectError(`page storage value for "${key}" is not JSON`, Code.InvalidArgument);
      }
      vals[key] = value;
      if (JSON.stringify(vals).length > MAX) throw new ConnectError("page storage is full (256 KiB per page); remove something first", Code.InvalidArgument);
    }
    this.storage.set(abs, vals);
    return { values: { ...vals } };
  }

  /**
   * Throws unless a command from the page at `path` (UiContext.page_path) may run, as the
   * daemon's Invoke: PermissionDenied with the page's access as a detail for a page refused or
   * not asked about.
   */
  checkInvoke(path: string): void {
    if (!path) return;
    try {
      this.allowed(path);
    } catch (err) {
      if (!(err instanceof ConnectError) || (err.code !== Code.PermissionDenied && err.code !== Code.FailedPrecondition)) throw err;
      const access = create(PageAccessSchema, this.getPage(path).page);
      throw new ConnectError(err.rawMessage, Code.PermissionDenied, undefined, [{ desc: PageAccessSchema, value: access }]);
    }
  }

  /** Throws unless the page may fetch (PageService.ProxyFetch's consent errors). */
  checkFetch(path: string): void {
    this.allowed(path);
  }

  /** view.open.page from a thread: it showed the page. */
  shown(path: string, thread: string): void {
    try {
      const abs = this.resolved(path);
      const before = this.owner(abs)?.thread;
      this.owners.set(abs, { thread, how: "shown", at: Date.now() });
      if (before !== thread) this.publish({ paths: [abs] });
    } catch {
      // Not a page: nothing to record, as the daemon.
    }
  }

  /** POST /__mock/page: scripts one page's owner, answer or unavailability. */
  script(path: string, q: { owner?: string | null; how?: string | null; consent?: string | null; unavailable?: string | null }): PageAccessInit {
    const abs = path.startsWith("~/") ? HOME + path.slice(1) : path;
    if (q.unavailable != null) {
      this.unavailable.set(abs, q.unavailable);
      return this.previewPage(abs);
    }
    this.unavailable.delete(abs);
    const real = this.world?.resolve(abs) ?? abs;
    if (q.owner === "") this.owners.delete(real);
    else if (q.owner) this.owners.set(real, { thread: q.owner, how: q.how === "written" ? "written" : "shown", at: Date.now() });
    if (q.consent === "allowed" || q.consent === "refused") this.answers.set(real, q.consent);
    else if (q.consent === "not-asked") this.answers.delete(real);
    this.publish({ paths: [real] });
    return this.previewPage(abs);
  }

  /** page.get, page.allow, page.disallow, as the daemon registers them (internal/command/commands_page.go). */
  commands() {
    const pathArg = { name: "path", type: ArgType.PATH, required: true, positional: true, description: "The page's .html or .htm file: absolute or ~/…" };
    const view = (path: string) => {
      const p = this.getPage(path).page;
      const consent = { [PageConsent.OWNED]: "owned", [PageConsent.ALLOWED]: "allowed", [PageConsent.REFUSED]: "refused", [PageConsent.NOT_ASKED]: "not-asked" } as Record<number, string>;
      const how = { [PageOwnerSource.SHOWN]: "shown", [PageOwnerSource.WRITTEN]: "written", [PageOwnerSource.PAGES_DIRECTORY]: "pages-directory" } as Record<number, string>;
      return JSON.stringify({ path: p.path, owner_thread: p.ownerThread, owner_source: how[p.ownerSource ?? 0] ?? "", consent: consent[p.consent ?? 0] ?? "", answer: consent[p.answer ?? 0] ?? "" });
    };
    const answer = (ctx: UiContext | undefined, args: Record<string, string>, a: Answer) => {
      // The answer is the user's about the page's script: never the page's own call.
      if (ctx?.origin === CallOrigin.PAGE) throw new ConnectError(`a page cannot answer for itself; the user ${a === "allowed" ? "allows" : "stops allowing"} it`, Code.PermissionDenied);
      const abs = this.resolved(args.path ?? "");
      const before = this.answers.get(abs);
      this.answers.set(abs, a);
      if (before !== a) this.publish({ paths: [abs] });
      this.calls.push(`${a === "allowed" ? "allow" : "disallow"} ${abs}`);
      return Promise.resolve({ message: `${a === "allowed" ? "allowed" : "not allowed"}: ${abs}`, resultJson: view(abs) });
    };
    const always = () => true;
    const def = (name: string, title: string, description: string, readOnly = false) => ({ name, title, category: "Pages", description, keybindings: [], noPalette: true, readOnly, args: [pathArg] });
    return [
      { cmd: def("page.get", "Show Page Access", "Who owns an HTML page and whether the user allowed it to use Code Foundry", true), when: always, run: (_ctx: UiContext | undefined, args: Record<string, string>) => Promise.resolve({ message: args.path ?? "", resultJson: view(args.path ?? "") }) },
      { cmd: def("page.allow", "Allow Page", "Let an HTML page no thread owns use Code Foundry"), when: always, run: (ctx: UiContext | undefined, args: Record<string, string>) => answer(ctx, args, "allowed") },
      { cmd: def("page.disallow", "Stop Allowing Page", "Stop an HTML page no thread owns from using Code Foundry"), when: always, run: (ctx: UiContext | undefined, args: Record<string, string>) => answer(ctx, args, "refused") },
    ];
  }
}
