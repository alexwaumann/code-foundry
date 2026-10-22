/**
 * view.panel.file, view.panel.diff and view.panel.pr in the mock daemon, like the
 * daemon's (internal/command/commands_view_items.go): always scoped to a thread (the
 * app's selection, or --thread), a ShowView with the item in its params, and --focus an
 * explicit FocusThread first. The mock checks only what it knows: the thread, a path in
 * its worktree for a diff, and a GitHub repository for a pull request. It does not read
 * files or diffs.
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
  cmd: { name: string; title: string; category: string; description: string; keybindings: string[]; args: { name: string; type: ArgType; required: boolean; description: string }[] };
  when: (ctx: UiContext | undefined) => boolean;
  run: (ctx: UiContext | undefined, args: Record<string, string>) => string | Promise<InvokeOut>;
};

const lead = "in a thread's side panel (from a thread: its own; in the app: the selected one): ";

/** The three item verbs over `lookup`, emitting through `emit`. */
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
        name: "view.panel.file",
        title: "Show File in Side Panel",
        category: "View",
        description: `Open a file in a File tab ${lead}text with syntax colours and an optional line marked, markdown rendered, images, PDFs, and HTML pages run interactively.`,
        keybindings: [],
        args: [
          { name: "path", type: ArgType.PATH, required: true, description: "File to show: absolute, ~/…, or relative to the current directory; under the home directory" },
          { name: "line", type: ArgType.INT, required: false, description: "1-based line to scroll to and mark" },
          ...panelThreadArgs,
        ],
      },
      when,
      run: (ctx, args) =>
        show(ctx, args, "panel.file", (t) => {
          const path = args.path ?? "";
          if (!path.startsWith("/")) throw new CommandError("invalid", `want an absolute path, got "${path}"`);
          return { path, project: t.projectId, base: t.worktreePath, ...(args.line ? { line: args.line } : {}) };
        }),
    },
    {
      cmd: {
        name: "view.panel.diff",
        title: "Show Diff in Side Panel",
        category: "View",
        description: `Open a changed file's diff in a Diff tab ${lead}the file against the branch's base, side by side or unified.`,
        keybindings: [],
        args: [
          { name: "path", type: ArgType.PATH, required: true, description: "Changed file in the thread's worktree: absolute, or relative to the current directory" },
          { name: "scope", type: ArgType.ENUM, required: false, description: "working: the base against the file on disk, uncommitted changes included; branch: against the last commit" },
          ...panelThreadArgs,
        ],
      },
      when,
      run: (ctx, args) =>
        show(ctx, args, "panel.diff", (t, id) => {
          const path = args.path ?? "";
          if (!t.projectId) throw new CommandError("unavailable", `thread ${id} runs in no project worktree`);
          if (!path.startsWith(t.worktreePath + "/")) throw new CommandError("invalid", `${path} is not a file in thread ${id}'s worktree ${t.worktreePath}`);
          return { project: t.projectId, worktree: t.worktreePath, path: path.slice(t.worktreePath.length + 1), scope: args.scope === "branch" ? "branch" : "working" };
        }),
    },
    {
      cmd: {
        name: "view.panel.pr",
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
