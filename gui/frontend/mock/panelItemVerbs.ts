/**
 * view.open.file, view.open.diff, view.open.pr, view.open.page and view.open.gallery in the
 * mock daemon, with their old names view.panel.<item> as unlisted aliases, like the
 * daemon's (internal/command/commands_view_items.go, commands_view_panel_page.go,
 * commands_view_panel_gallery.go, commands_view_open.go). Each opens the thread's tab (the
 * app's selection, or --thread) in the mock layout: open_surface, linked to the thread, with
 * the item in the tab's params; from the app it takes the focus, from a caller without a view
 * only with --focus. The tab is the whole effect: no intent goes out
 * (docs/notes/shell-22-retire-verbs.md). The mock checks only what it knows: the thread, a path in
 * one of its checkouts for a diff, and a GitHub repository for a pull request. It does not
 * read files, and of a diff only which files changed (to tell a file from a directory); of
 * view.panel.file --edit's refusals only --note without --edit: they are Go's to test, as is
 * cleaning the note. A page's or diff's --title is cleaned and capped as there, and a diff's
 * params are the daemon's (commands_view_diff.go diffCheck).
 */
import { ArgType, type UiContext } from "../src/gen/codefoundry/v1/command_pb";
import { plainLine } from "../src/lib/plainText";
import { CommandError } from "./errors";
import type { InvokeOut } from "./gitops";
import { panes, type Op, type State, type Tab } from "./layout";
import { DIFF_ASKER_PARAM, identityKey } from "../src/shell/identity";

/** The item verbs' --thread and --focus (internal/command openThreadArg, openFocusArg). */
const itemThreadArgs = [
  {
    name: "thread",
    type: ArgType.STRING,
    required: false,
    description:
      "Thread the tab belongs to; it opens beside it without taking the user's focus (default: the thread this runs in, $CODE_FOUNDRY_THREAD; in the app: the selected thread) (or a unique suffix of 4+ characters)",
  },
  { name: "focus", type: ArgType.BOOL, required: false, description: "Also take the user's focus to the tab; only when the user asked to be taken there" },
];

/** A fresh request id for a file request (internal/command newAskID). */
function newAskId(): string {
  return Array.from(crypto.getRandomValues(new Uint8Array(6)), (b) => b.toString(16).padStart(2, "0")).join("");
}

/** What the item verbs read about a thread; undefined for one the mock does not know. */
export interface ItemThread {
  projectId: string;
  worktreePath: string;
  /** The thread's project's GitHub repository, "" without one. */
  githubSlug: string;
  /** The thread's other checkouts (a workspace's projects), each a project and its root. */
  checkouts?: { projectId: string; path: string }[];
  /** A checkout's changed files, relative to its root; undefined when the mock has none for it. */
  changed?: (root: string) => readonly string[] | undefined;
}

type Command = {
  cmd: { name: string; title: string; category: string; description: string; keybindings: string[]; noPalette?: boolean; args: { name: string; type: ArgType; required: boolean; description: string }[] };
  when: (ctx: UiContext | undefined) => boolean;
  run: (ctx: UiContext | undefined, args: Record<string, string>) => string | Promise<InvokeOut>;
};

const lead = "beside a thread (from a thread: its own; in the app: the selected one): ";

/** --hide's values (internal/command diffHides). */
const DIFF_HIDES = ["compare", "files"];

/**
 * A --base or --head value as the Diff tab's param, like the daemon's diffSource: undefined
 * for none or the side's default, a named source as itself, anything else a ref.
 */
function diffSource(v: string | undefined, def: string): string | undefined {
  if (!v || v === def) return undefined;
  return ["working", "staged", "merge-base"].includes(v) ? v : `ref:${v}`;
}

/** path relative to root ("" for root itself), or undefined when it is not in it. */
function inCheckout(root: string, path: string): string | undefined {
  const p = path.replace(/\/+$/, "");
  if (p === root) return "";
  return p.startsWith(`${root}/`) ? p.slice(root.length + 1) : undefined;
}

/**
 * The checkout a diff's paths are in, as the daemon's resolveDiffPaths places them: the
 * deepest of the thread's checkouts holding each, all in one; the root among them is every
 * file.
 */
function diffCheckout(t: ItemThread, id: string, paths: string[]): { project: string; root: string; rels: string[] } {
  const c = { project: t.projectId, root: t.worktreePath, rels: [] as string[] };
  const all = [{ projectId: t.projectId, path: t.worktreePath }, ...(t.checkouts ?? [])];
  let whole = false;
  for (const [i, p] of paths.entries()) {
    let found: { projectId: string; path: string; rel: string } | undefined;
    for (const k of all) {
      const rel = inCheckout(k.path, p);
      if (rel !== undefined && (!found || k.path.length > found.path.length)) found = { ...k, rel };
    }
    if (!found) throw new CommandError("invalid", `${p} is not a file in thread ${id}'s worktree ${t.worktreePath}`);
    if (i > 0 && found.path !== c.root) throw new CommandError("invalid", `${p} is in ${found.path} and the paths before it in ${c.root}: one tab shows one checkout, so run this once for each`);
    c.project = found.projectId;
    c.root = found.path;
    if (found.rel === "") whole = true;
    else c.rels.push(found.rel);
  }
  if (whole) c.rels = [];
  return c;
}

/** The longest --title, in characters (internal/command maxDiffTitle): it is a tab's name. */
const MAX_TITLE = 100;

/** --title cleaned as the daemon cleans it (plainNote), refused past MAX_TITLE characters. */
function tabTitle(args: Record<string, string>): string {
  const title = plainLine(args.title ?? "");
  const n = Array.from(title).length;
  if (n > MAX_TITLE) throw new CommandError("invalid", `${String(n)} characters, at most ${String(MAX_TITLE)}`);
  return title;
}

/** A diff tab's side param as the window reads it (internal/command sideParam): "" for the side's default. */
function sideParam(v: string | undefined, def: string): string {
  if (!v || v === def) return "";
  if (["working", "staged", "merge-base"].includes(v) || (v.startsWith("ref:") && v.length > 4)) return v;
  return "";
}

/** A Diff tab's params while it shows one commit from its Commits list (internal/command diffCommitParams). */
const COMMIT_PARAMS = ["commit", "backBase", "backHead", "backPath", "backOldPath"];

/**
 * Like the daemon's intoUsersDiff (internal/command/commands_view_diff_pick.go): a diff that frames
 * nothing (no asker) while the checkout's own tab is open is that tab as the user has it, with the
 * call's file picked there (out of a commit the user was in). When the user's tab compares other
 * sides, the file is picked only if `listed` says those sides list it (the mock does not compare:
 * the world says whether the checkout changed the file); otherwise it opens in a tab of `asker`'s own.
 */
export function intoUsersDiff(st: State, op: Op, asker: string, listed: (root: string, file: string) => boolean = () => true): Op {
  const tab = op.op === "open_surface" ? (op.tab as Tab | undefined) : undefined;
  if (tab?.kind !== "diff" || tab.params?.[DIFF_ASKER_PARAM]) return op;
  const thread = tab.thread ?? "";
  const asked = tab.params ?? {};
  const key = identityKey("diff", thread, asked);
  const space = st.spaces.find((sp) => sp.id === (st.threads?.[thread]?.space ?? st.default_space));
  const open = key === null ? undefined : panes(space?.root).flatMap((p) => p.tabs ?? []).find((t) => t.kind === "diff" && identityKey("diff", t.thread ?? "", t.params ?? {}) === key);
  if (!open) return op;
  const kept = Object.entries(open.params ?? {}).filter(([k]) => !COMMIT_PARAMS.includes(k));
  const mine: Record<string, string> = { ...open.params };
  if (asked.own) mine.own = asked.own;
  else delete mine.own;
  const file = asked.path;
  if (!file) return { ...op, tab: { ...tab, params: mine } };
  const base = sideParam(mine.commit ? mine.backBase : mine.base, "merge-base");
  const head = sideParam(mine.commit ? mine.backHead : mine.head, "working");
  if ((base !== sideParam(asked.base, "merge-base") || head !== sideParam(asked.head, "working")) && !listed(mine.worktree ?? "", file)) {
    return { ...op, tab: { ...tab, params: { ...asked, [DIFF_ASKER_PARAM]: asker } } };
  }
  // The commit's params go: the file is picked in the sides the commit was opened from.
  const { base: _b, head: _h, path: _p, oldPath: _o, ...rest } = Object.fromEntries(kept);
  const picked: Record<string, string> = { ...rest, path: file };
  if (asked.own) picked.own = asked.own;
  else delete picked.own;
  if (base) picked.base = base;
  if (head) picked.head = head;
  if (asked.oldPath && asked.oldPath !== file) picked.oldPath = asked.oldPath;
  return { ...op, tab: { ...tab, params: picked } };
}

/** A tab's title as the daemon gives it (internal/command itemTab): a file's name or a page's title, "#n", a gallery's or diff's title. */
function itemTitle(kind: string, p: Record<string, string>): { title?: string } {
  const title = kind === "file" ? p.title || (p.path ?? "").split("/").pop() || "" : kind === "pullrequest" ? `#${p.number ?? ""}` : p.title ?? "";
  return title ? { title } : {};
}

/** Applies a layout op; keepFocus runs it without moving the user's focus (a thread's call). */
export type PlaceTab = (op: Op, keepFocus: boolean) => void;

/** --pane: the pane whose + menu asked (internal/command openPaneArg). */
const paneArg = { name: "pane", type: ArgType.STRING, required: false, description: "Open the tab in this pane (the pane's + menu); a linked tab that is already open is focused where it is" };

/** The classic alias of a view.open verb: the same command, out of the palette. */
function alias(c: Command): Command {
  return { ...c, cmd: { ...c.cmd, name: c.cmd.name.replace("view.open.", "view.panel."), noPalette: true, description: `The old name of ${c.cmd.name}, kept for one stable release. ${c.cmd.description}` } };
}

/** The item verbs over `lookup`, opening their tabs through `place`. */
export function panelItemCommands(lookup: (id: string) => ItemThread | undefined, place?: PlaceTab): Command[] {
  const when = (ctx: UiContext | undefined) => Boolean(ctx?.activeThreadId);
  const show = (ctx: UiContext | undefined, args: Record<string, string>, kind: string, params: (t: ItemThread, id: string) => Record<string, string>): string => {
    const id = args.thread || ctx?.activeThreadId || "";
    const t = lookup(id);
    if (!t) throw new CommandError("notfound", `thread not found: ${id}`);
    const p = params(t, id);
    // Like the daemon's wantsFocus: the user's call (the app) takes the focus, a thread's only with --focus.
    const focus = args.focus === undefined ? Boolean(ctx?.activeView) : args.focus === "true";
    place?.({ op: "open_surface", tab: { id: "", kind, thread: id, params: p, ...itemTitle(kind, p) }, focus, ...(args.pane ? { pane: args.pane } : {}) }, !focus);
    // Like the daemon: a message for the CLI only (the app toasts non-empty ones).
    return ctx?.activeView ? "" : `opened a ${kind} tab for thread ${id}`;
  };
  const verbs: Command[] = [
    {
      cmd: {
        name: "view.open.file", noPalette: true,
        title: "Open File Tab",
        category: "View",
        description: `Open a file in a File tab ${lead}text with syntax colours and an optional line marked, markdown rendered, images, PDFs, and HTML pages run interactively.`,
        keybindings: [],
        args: [
          { name: "path", type: ArgType.PATH, required: true, description: "File to show: absolute, ~/…, or relative to the current directory; under the home directory" },
          { name: "line", type: ArgType.INT, required: false, description: "1-based line to scroll to and mark" },
          { name: "edit", type: ArgType.BOOL, required: false, description: "Ask the user to edit the file" },
          { name: "note", type: ArgType.STRING, required: false, description: "With --edit: what to put where" },
          ...itemThreadArgs,
          paneArg,
        ],
      },
      when,
      run: (ctx, args) =>
        show(ctx, args, "file", (t, id) => {
          const path = args.path ?? "";
          if (!path.startsWith("/")) throw new CommandError("invalid", `want an absolute path, got "${path}"`);
          if (args.note && args.edit !== "true") throw new CommandError("invalid", "only with --edit");
          const asked =
            args.edit === "true"
              ? { edit: "1", asker: id, askId: newAskId(), ...(args.note ? { note: args.note } : {}), ...(args.focus === "true" ? { focus: "1" } : {}) }
              : {};
          return { path, project: t.projectId, base: t.worktreePath, ...(args.line ? { line: args.line } : {}), ...asked };
        }),
    },
    {
      cmd: {
        name: "view.open.page", noPalette: true,
        title: "Open HTML Page Tab",
        category: "View",
        description: `Open an HTML page in a File tab ${lead}the page alone, no card in the conversation, run with the thread's /cf/bridge.js as view.inline --panel's is.`,
        keybindings: [],
        args: [
          { name: "path", type: ArgType.PATH, required: true, description: "The .html or .htm file: absolute, ~/…, or relative to the current directory; under the home directory" },
          { name: "title", type: ArgType.STRING, required: false, description: "The tab's title (default: the file's name), at most 100 characters" },
          ...itemThreadArgs,
          paneArg,
        ],
      },
      when,
      run: (ctx, args) =>
        show(ctx, args, "file", (t) => {
          const path = args.path ?? "";
          if (!path.startsWith("/")) throw new CommandError("invalid", `want an absolute path, got "${path}"`);
          if (!/\.html?$/i.test(path)) throw new CommandError("invalid", `${path} is not an .html or .htm file (view.open.file shows any file)`);
          const title = tabTitle(args);
          return { path, project: t.projectId, base: t.worktreePath, page: "1", ...(title ? { title } : {}) };
        }),
    },
    {
      cmd: {
        name: "view.open.gallery", noPalette: true,
        title: "Open Images Tab",
        category: "View",
        description: `Open a set of images in a Gallery tab ${lead}a grid of captioned images, each opening large over a filmstrip.`,
        keybindings: [],
        args: [
          { name: "title", type: ArgType.STRING, required: true, description: "The tab's title; the same title updates the same tab" },
          { name: "images", type: ArgType.STRING, required: true, description: "The images in order, a JSON array of path and caption" },
          ...itemThreadArgs,
          paneArg,
        ],
      },
      when,
      run: (ctx, args) => show(ctx, args, "gallery", (t) => ({ title: args.title ?? "", images: args.images ?? "", project: t.projectId, base: t.worktreePath })),
    },
    {
      cmd: {
        name: "view.open.diff", noPalette: true,
        title: "Open Diff Tab",
        category: "View",
        description: `Open a changed file's diff in a Diff tab ${lead}the file against the branch's base, side by side or unified.`,
        keybindings: [],
        args: [
          { name: "path", type: ArgType.PATH, required: false, description: "Changed file in the thread's worktree: absolute, or relative to the current directory" },
          { name: "scope", type: ArgType.ENUM, required: false, description: "working: the base against the file on disk, uncommitted changes included; branch: against the last commit" },
          { name: "base", type: ArgType.STRING, required: false, description: "The older side" },
          { name: "head", type: ArgType.STRING, required: false, description: "The newer side" },
          { name: "title", type: ArgType.STRING, required: false, description: "The tab's name, at most 100 characters" },
          { name: "note", type: ArgType.STRING, required: false, description: "A line under the title" },
          { name: "hide", type: ArgType.STRING, required: false, description: "compare or files" },
          ...itemThreadArgs,
          paneArg,
        ],
      },
      when,
      run: (ctx, args) =>
        show(ctx, args, "diff", (t, id) => {
          if (!t.projectId) throw new CommandError("unavailable", `thread ${id} runs in no project worktree`);
          if (args.scope !== undefined && (args.base || args.head)) throw new CommandError("invalid", "says the same as --base and --head: give one or the other");
          const base = diffSource(args.base, "merge-base");
          const head = args.scope === "branch" ? "ref:HEAD" : diffSource(args.head, "working");
          const c = diffCheckout(t, id, (args.path ?? "").split("\n").filter(Boolean));
          const title = tabTitle(args);
          const hide = (args.hide ?? "").split("\n").filter(Boolean);
          for (const h of hide) if (!DIFF_HIDES.includes(h)) throw new CommandError("invalid", `want ${DIFF_HIDES.join(" or ")}, got ${JSON.stringify(h)}`);
          // One changed file is picked in the whole list; anything else (a directory, several) narrows it.
          const changed = t.changed?.(c.root);
          const [only] = c.rels;
          const one = c.rels.length === 1 && only !== undefined && (!changed || changed.includes(only)) ? only : undefined;
          const paths = one === undefined && c.rels.length > 0 ? c.rels.join("\n") : "";
          // Like the daemon: anything but choosing a file gets a tab of its own, the checkout's being the user's.
          const framed = args.base !== undefined || args.head !== undefined || args.scope !== undefined || title || args.note || hide.length > 0 || paths;
          return {
            project: c.project,
            worktree: c.root,
            ...(c.root === t.worktreePath ? { own: "1" } : {}),
            ...(framed ? { thread: id } : {}),
            ...(base ? { base } : {}),
            ...(head ? { head } : {}),
            ...(one !== undefined ? { path: one } : {}),
            ...(paths ? { paths } : {}),
            ...(title ? { title } : {}),
            ...(args.note ? { note: args.note } : {}),
            ...(hide.length > 0 ? { hide: hide.join(",") } : {}),
          };
        }),
    },
    {
      cmd: {
        name: "view.open.pr", noPalette: true,
        title: "Open Pull Request Tab",
        category: "View",
        description: `Open a pull request ${lead}its summary, checks, reviews, timeline and changed files, with Merge and Review.`,
        keybindings: [],
        args: [{ name: "number", type: ArgType.INT, required: true, description: "Pull request number: one the thread links, else one in its project's GitHub repository" }, ...itemThreadArgs, paneArg],
      },
      when,
      run: (ctx, args) =>
        show(ctx, args, "pullrequest", (t, id) => {
          if (!t.githubSlug) throw new CommandError("unavailable", `thread ${id} links no pull request #${args.number ?? ""} and its project has no GitHub repository`);
          return { slug: t.githubSlug, number: args.number ?? "" };
        }),
    },
  ];
  return verbs.flatMap((c) => [c, alias(c)]);
}
