/**
 * view.open.file, view.open.diff, view.open.pr, view.open.page and view.open.gallery in the
 * mock daemon, with their classic names view.panel.<item> as unlisted aliases, like the
 * daemon's (internal/command/commands_view_items.go, commands_view_panel_page.go,
 * commands_view_panel_gallery.go, commands_view_open.go). Each opens the thread's tab in the
 * mock layout (open_surface, linked to the thread; from the app it takes the focus, from a
 * caller without a view only with --focus) and still sends the classic window its ShowView:
 * always scoped to a thread (the
 * app's selection, or --thread), a ShowView with the item in its params, and --focus an
 * explicit FocusThread first. The mock checks only what it knows: the thread, a path in
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
import { panelThreadArgs } from "./panelVerbs";
import type { UiIntentInit } from "./world";

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

const lead = "beside a thread (from a thread: its own; in the app: the selected one; the classic window: its side panel): ";

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

/**
 * Like the daemon's tabs.open (internal/command/commands_view_open.go): a diff that frames nothing
 * (no asker) shows an open checkout tab of its identity as the user has it, its params kept; the
 * window picks the file there (stores/threadPanelIntent.ts).
 */
export function keepUsersDiff(st: State, op: Op): Op {
  const tab = op.op === "open_surface" ? (op.tab as Tab | undefined) : undefined;
  if (tab?.kind !== "diff" || tab.params?.[DIFF_ASKER_PARAM]) return op;
  const thread = tab.thread ?? "";
  const key = identityKey("diff", thread, tab.params ?? {});
  const space = st.spaces.find((sp) => sp.id === (st.threads?.[thread]?.space ?? st.default_space));
  for (const p of panes(space?.root)) {
    const open = (p.tabs ?? []).find((t) => t.kind === "diff" && identityKey("diff", t.thread ?? "", t.params ?? {}) === key);
    if (key !== null && open) return { ...op, tab: { ...tab, params: { ...open.params } } };
  }
  return op;
}

/** Applies a layout op; keepFocus runs it without moving the user's focus (a thread's call). */
export type PlaceTab = (op: Op, keepFocus: boolean) => void;

/** --pane: the pane whose + menu asked (internal/command openPaneArg). */
const paneArg = { name: "pane", type: ArgType.STRING, required: false, description: "Open the tab in this pane (the pane's + menu); a linked tab that is already open is focused where it is" };

/** The classic alias of a view.open verb: the same command, out of the palette. */
function alias(c: Command): Command {
  return { ...c, cmd: { ...c.cmd, name: c.cmd.name.replace("view.open.", "view.panel."), noPalette: true, description: `The old name of ${c.cmd.name}, kept for one stable release. ${c.cmd.description}` } };
}

/** The item verbs over `lookup`, emitting through `emit` and opening their tabs through `place`. */
export function panelItemCommands(lookup: (id: string) => ItemThread | undefined, emit: (i: UiIntentInit) => number, place?: PlaceTab): Command[] {
  const when = (ctx: UiContext | undefined) => Boolean(ctx?.activeThreadId);
  const show = (ctx: UiContext | undefined, args: Record<string, string>, name: string, kind: string, params: (t: ItemThread, id: string) => Record<string, string>): string => {
    const id = args.thread || ctx?.activeThreadId || "";
    const t = lookup(id);
    if (!t) throw new CommandError("notfound", `thread not found: ${id}`);
    const p = params(t, id);
    // Like the daemon's wantsFocus: the user's call (the app) takes the focus, a thread's only with --focus.
    const focus = args.focus === undefined ? Boolean(ctx?.activeView) : args.focus === "true";
    place?.({ op: "open_surface", tab: { id: "", kind, thread: id, params: p }, focus, ...(args.pane ? { pane: args.pane } : {}) }, !focus);
    if (args.focus === "true") emit({ intent: { case: "focusThread", value: { threadId: id, explicit: true } } });
    const n = emit({ intent: { case: "showView", value: { name, threadId: id, params: p } } });
    // Like the daemon: a message for the CLI only (the app toasts non-empty ones).
    return ctx?.activeView ? "" : `windows=${String(n)} thread=${id}`;
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
          ...panelThreadArgs,
          paneArg,
        ],
      },
      when,
      run: (ctx, args) =>
        show(ctx, args, "panel.file", "file", (t, id) => {
          const path = args.path ?? "";
          if (!path.startsWith("/")) throw new CommandError("invalid", `want an absolute path, got "${path}"`);
          if (args.note && args.edit !== "true") throw new CommandError("invalid", "only with --edit");
          const asked =
            args.edit === "true"
              ? { edit: "1", thread: id, ...(args.note ? { note: args.note } : {}), ...(args.focus === "true" ? { focus: "1" } : {}) }
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
          ...panelThreadArgs,
          paneArg,
        ],
      },
      when,
      run: (ctx, args) =>
        show(ctx, args, "panel.file", "file", (t) => {
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
          ...panelThreadArgs,
          paneArg,
        ],
      },
      when,
      run: (ctx, args) => show(ctx, args, "panel.gallery", "gallery", (t) => ({ title: args.title ?? "", images: args.images ?? "", project: t.projectId, base: t.worktreePath })),
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
          ...panelThreadArgs,
          paneArg,
        ],
      },
      when,
      run: (ctx, args) =>
        show(ctx, args, "panel.diff", "diff", (t, id) => {
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
        args: [{ name: "number", type: ArgType.INT, required: true, description: "Pull request number: one the thread links, else one in its project's GitHub repository" }, ...panelThreadArgs, paneArg],
      },
      when,
      run: (ctx, args) =>
        show(ctx, args, "panel.pr", "pullrequest", (t, id) => {
          if (!t.githubSlug) throw new CommandError("unavailable", `thread ${id} links no pull request #${args.number ?? ""} and its project has no GitHub repository`);
          return { slug: t.githubSlug, number: args.number ?? "" };
        }),
    },
  ];
  return verbs.flatMap((c) => [c, alias(c)]);
}
