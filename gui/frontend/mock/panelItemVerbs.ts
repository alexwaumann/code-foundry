/**
 * view.panel.file, view.panel.diff, view.panel.pr, view.panel.page and view.panel.gallery in
 * the mock daemon, like the daemon's (internal/command/commands_view_items.go,
 * commands_view_panel_page.go, commands_view_panel_gallery.go):
 * always scoped to a thread (the
 * app's selection, or --thread), a ShowView with the item in its params, and --focus an
 * explicit FocusThread first. The mock checks only what it knows: the thread, a path in
 * its worktree for a diff, and a GitHub repository for a pull request. It does not read
 * files or diffs, and of view.panel.file --edit's refusals only --note without --edit: they are
 * Go's to test, as is cleaning the note.
 */
import { ArgType, type UiContext } from "../src/gen/codefoundry/v1/command_pb";
import { CommandError } from "./errors";
import type { InvokeOut } from "./gitops";
import { panelThreadArgs } from "./panelVerbs";
import type { UiIntentInit } from "./world";

/** What the item verbs read about a thread; undefined for one the mock does not know. */
export interface ItemThread {
  projectId: string;
  worktreePath: string;
  /** The thread's project's GitHub repository, "" without one. */
  githubSlug: string;
}

type Command = {
  cmd: { name: string; title: string; category: string; description: string; keybindings: string[]; noPalette?: boolean; args: { name: string; type: ArgType; required: boolean; description: string }[] };
  when: (ctx: UiContext | undefined) => boolean;
  run: (ctx: UiContext | undefined, args: Record<string, string>) => string | Promise<InvokeOut>;
};

const lead = "in a thread's side panel (from a thread: its own; in the app: the selected one): ";

/** The item verbs over `lookup`, emitting through `emit`. */
export function panelItemCommands(lookup: (id: string) => ItemThread | undefined, emit: (i: UiIntentInit) => number): Command[] {
  const when = (ctx: UiContext | undefined) => Boolean(ctx?.activeThreadId);
  const show = (ctx: UiContext | undefined, args: Record<string, string>, name: string, params: (t: ItemThread, id: string) => Record<string, string>): string => {
    const id = args.thread || ctx?.activeThreadId || "";
    const t = lookup(id);
    if (!t) throw new CommandError("notfound", `thread not found: ${id}`);
    const p = params(t, id);
    if (args.focus === "true") emit({ intent: { case: "focusThread", value: { threadId: id, explicit: true } } });
    const n = emit({ intent: { case: "showView", value: { name, threadId: id, params: p } } });
    // Like the daemon: a message for the CLI only (the app toasts non-empty ones).
    return ctx?.activeView ? "" : `windows=${String(n)} thread=${id}`;
  };
  return [
    {
      cmd: {
        name: "view.panel.file", noPalette: true,
        title: "Show File in Side Panel",
        category: "View",
        description: `Open a file in a File tab ${lead}text with syntax colours and an optional line marked, markdown rendered, images, PDFs, and HTML pages run interactively.`,
        keybindings: [],
        args: [
          { name: "path", type: ArgType.PATH, required: true, description: "File to show: absolute, ~/…, or relative to the current directory; under the home directory" },
          { name: "line", type: ArgType.INT, required: false, description: "1-based line to scroll to and mark" },
          { name: "edit", type: ArgType.BOOL, required: false, description: "Ask the user to edit the file" },
          { name: "note", type: ArgType.STRING, required: false, description: "With --edit: what to put where" },
          ...panelThreadArgs,
        ],
      },
      when,
      run: (ctx, args) =>
        show(ctx, args, "panel.file", (t, id) => {
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
        name: "view.panel.page", noPalette: true,
        title: "Show HTML Page in Side Panel",
        category: "View",
        description: `Open an HTML page in a File tab ${lead}the page alone, no card in the conversation, run with the thread's /cf/bridge.js as view.inline --panel's is.`,
        keybindings: [],
        args: [
          { name: "path", type: ArgType.PATH, required: true, description: "The .html or .htm file: absolute, ~/…, or relative to the current directory; under the home directory" },
          { name: "title", type: ArgType.STRING, required: false, description: "The tab's title (default: the file's name)" },
          ...panelThreadArgs,
        ],
      },
      when,
      run: (ctx, args) =>
        show(ctx, args, "panel.file", (t) => {
          const path = args.path ?? "";
          if (!path.startsWith("/")) throw new CommandError("invalid", `want an absolute path, got "${path}"`);
          if (!/\.html?$/i.test(path)) throw new CommandError("invalid", `${path} is not an .html or .htm file (view.panel.file shows any file)`);
          const title = (args.title ?? "").trim();
          return { path, project: t.projectId, base: t.worktreePath, page: "1", ...(title ? { title } : {}) };
        }),
    },
    {
      cmd: {
        name: "view.panel.gallery", noPalette: true,
        title: "Show Images in Side Panel",
        category: "View",
        description: `Open a set of images in a Gallery tab ${lead}a grid of captioned images, each opening large over a filmstrip.`,
        keybindings: [],
        args: [
          { name: "title", type: ArgType.STRING, required: true, description: "The tab's title; the same title updates the same tab" },
          { name: "images", type: ArgType.STRING, required: true, description: "The images in order, a JSON array of path and caption" },
          ...panelThreadArgs,
        ],
      },
      when,
      run: (ctx, args) => show(ctx, args, "panel.gallery", (t) => ({ title: args.title ?? "", images: args.images ?? "", project: t.projectId, base: t.worktreePath })),
    },
    {
      cmd: {
        name: "view.panel.diff", noPalette: true,
        title: "Show Diff in Side Panel",
        category: "View",
        description: `Open a changed file's diff in a Diff tab ${lead}the file against the branch's base, side by side or unified.`,
        keybindings: [],
        args: [
          { name: "path", type: ArgType.PATH, required: false, description: "Changed file in the thread's worktree: absolute, or relative to the current directory" },
          { name: "scope", type: ArgType.ENUM, required: false, description: "working: the base against the file on disk, uncommitted changes included; branch: against the last commit" },
          { name: "base", type: ArgType.STRING, required: false, description: "The older side" },
          { name: "head", type: ArgType.STRING, required: false, description: "The newer side" },
          { name: "title", type: ArgType.STRING, required: false, description: "The tab's name" },
          { name: "note", type: ArgType.STRING, required: false, description: "A line under the title" },
          { name: "hide", type: ArgType.STRING, required: false, description: "compare or files" },
          ...panelThreadArgs,
        ],
      },
      when,
      run: (ctx, args) =>
        show(ctx, args, "panel.diff", (t, id) => {
          if (!t.projectId) throw new CommandError("unavailable", `thread ${id} runs in no project worktree`);
          const paths = (args.path ?? "").split("\n").filter(Boolean);
          for (const p of paths) if (!p.startsWith(t.worktreePath + "/")) throw new CommandError("invalid", `${p} is not a file in thread ${id}'s worktree ${t.worktreePath}`);
          const rels = paths.map((p) => p.slice(t.worktreePath.length + 1));
          const source = (v: string | undefined) => (!v ? undefined : ["working", "staged", "merge-base"].includes(v) ? v : `ref:${v}`);
          const head = args.scope === "branch" ? "ref:HEAD" : source(args.head);
          const base = source(args.base);
          // Like the daemon: anything but choosing a file gets a tab of its own, the checkout's being the user's.
          const framed = rels.length > 1 || args.title || args.note || args.hide;
          return {
            project: t.projectId,
            worktree: t.worktreePath,
            own: "1",
            ...(framed ? { thread: id } : {}),
            ...(base ? { base } : {}),
            ...(head ? { head } : {}),
            ...(rels.length === 1 ? { path: rels[0] ?? "" } : rels.length > 1 ? { paths: rels.join("\n") } : {}),
            ...(args.title ? { title: args.title } : {}),
            ...(args.note ? { note: args.note } : {}),
            ...(args.hide ? { hide: args.hide.split("\n").join(",") } : {}),
          };
        }),
    },
    {
      cmd: {
        name: "view.panel.pr", noPalette: true,
        title: "Show Pull Request in Side Panel",
        category: "View",
        description: `Open a pull request ${lead}its summary, checks, reviews, timeline and changed files, with Merge and Review.`,
        keybindings: [],
        args: [{ name: "number", type: ArgType.INT, required: true, description: "Pull request number: one the thread links, else one in its project's GitHub repository" }, ...panelThreadArgs],
      },
      when,
      run: (ctx, args) =>
        show(ctx, args, "panel.pr", (t, id) => {
          if (!t.githubSlug) throw new CommandError("unavailable", `thread ${id} links no pull request #${args.number ?? ""} and its project has no GitHub repository`);
          return { slug: t.githubSlug, number: args.number ?? "" };
        }),
    },
  ];
}
