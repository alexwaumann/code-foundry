/**
 * pr.task (internal/command/commands_prtask.go): the pull request panel's "have the
 * thread handle it" actions. With thread the task goes into that thread as a message
 * (thread.send's path: a user message, then a short reply) and nothing is focused;
 * without, a thread starts on the pull request's head branch, its worktree reused or
 * created, after cloning the repository as a project when none is a clone of it
 * (into ~/.code-foundry/projects/<owner>/<name>, as ProjectService.Clone). The result
 * JSON is the daemon's PRTaskResult. The prompt is a one-line stand-in for the daemon's
 * (prtaskprompt.go); the mock's threads never read it.
 *
 * With thread, a link the thread has through a thread it created (a child copy: `via`)
 * is forwarded as the daemon does (docs/notes/pr-task-forward.md): the task goes to the
 * owner (via hop by hop, a gone hop or a cycle sends to the thread itself), the thread
 * gets a "Sent to <owner>: <task> (#N)" note, and the result names it (viaThreadId). The
 * one wake when the owner settles is not mirrored: the mock's threads never settle from a
 * task. POST /__mock/link-pr?…&up=1 copies a link up the creator chain with via.
 *
 * Kept apart from world.ts's pr.ask/pr.explain/pr.fix.findings so a change to those does
 * not touch this. POST /__mock/gh/pr-fail?command=pr.task fails the next run with the
 * daemon's fork refusal; POST /__mock/gh/pr-delay?ms=… delays it too.
 */
import { Code, ConnectError } from "@connectrpc/connect";
import { ArgType, type UiContext } from "../src/gen/codefoundry/v1/command_pb";
import type { InvokeOut } from "./gitops";
import { CommandError } from "./errors";
import { PROJECTS, cloneExists } from "./clone";
import { MODEL_VALUES } from "./settings";

/** pr.task's kinds, as the daemon's PRTaskKinds. */
export const PR_TASK_KINDS = ["checks", "review", "conversations", "conflicts", "behind", "review-request"] as const;

/** The task in a few words, for a forward's note (the daemon's prTask.title). */
const TITLES: Readonly<Record<(typeof PR_TASK_KINDS)[number], string>> = {
  checks: "Fix the failing checks",
  review: "Address the requested changes",
  conversations: "Address the unresolved conversations",
  conflicts: "Resolve the conflicts",
  behind: "Bring the branch up to date",
  "review-request": "Review it (read-only)",
};

/** The stand-in prompt's lead per kind (the daemon's prTaskHeader leads). */
const LEADS: Readonly<Record<(typeof PR_TASK_KINDS)[number], string>> = {
  checks: "Fix the failing checks on",
  review: "Address the requested changes on",
  conversations: "Address the unresolved review conversations on",
  conflicts: "Resolve the merge conflicts on",
  behind: "Bring the branch up to date with its base on",
  "review-request": "Review",
};

/** pr.task's args that only a new thread uses (the daemon's prTaskNewThreadArgs). */
const NEW_THREAD_ARGS = ["worktree", "model", "effort", "focus"] as const;

/** The worktree shape pr.task reads (world.ts's MockWorktree). */
interface TaskWorktree {
  path: string;
  branch: string;
  head: string;
  isMain: boolean;
  status: { upstream: string };
}

/** The project shape pr.task reads (world.ts's MockProject). */
interface TaskProject {
  id: string;
  path: string;
  githubSlug: string;
  worktrees: TaskWorktree[];
}

/** The pull request fields pr.task reads. */
interface TaskPullRequest {
  /** GitHub's current name for the repository. */
  repoSlug?: string;
  headRef?: string;
  headSha?: string;
  isCrossRepository?: boolean;
}

/** What pr.task needs from the world. */
export interface PrTaskDeps {
  /** The pull request (GetPullRequestDetail; refreshed for the tasks that push). */
  pullRequest(slug: string, n: number, refresh: boolean): TaskPullRequest | undefined;
  projects(): TaskProject[];
  /** Registers a clone (world.addClone). */
  addClone(owner: string, name: string, path: string): TaskProject;
  /** Creates the head branch's worktree in project, tracking origin/<head>. */
  addWorktree(project: TaskProject, branch: string, head: string): TaskWorktree;
  thread(id: string): { id: string; name: string; linkedPullRequests: readonly TaskLink[] } | undefined;
  /** A note in the thread's conversation (no turn). */
  addNote(id: string, text: string): void;
  /** Every thread's id, for the daemon's id-suffix resolution. */
  threadIds(): string[];
  /** Starts a thread with prompt as its first message (no focus). */
  startThread(projectId: string, path: string, model: string, effort: string, prompt: string): { id: string; name: string };
  /** thread.send's path; the message item's ordinal. */
  send(id: string, text: string): number;
  focusThread(id: string): void;
  defaults(): { model: string; effort: string };
  /** POST /__mock/gh/pr-fail and pr-delay. */
  failNext: Set<string>;
  delayMs(): number;
}

/** A thread's link as pr.task's forward reads it: via is the direct child a copy came through. */
export interface TaskLink {
  slug: string;
  number: number;
  via?: string;
}

/**
 * The daemon's thread.LinkOwner: the thread whose own link start's link to slug#n is,
 * following child copies' via hop by hop; start itself when its link is its own, it has
 * none, or the chain breaks (a hop gone or without the link, a cycle, more than 8 hops).
 */
export function linkOwner(start: string, slugs: readonly string[], n: number, links: (id: string) => readonly TaskLink[] | undefined): string {
  const want = new Set(slugs.filter(Boolean).map((x) => x.toLowerCase()));
  const seen = new Set([start]);
  for (let cur = start, hops = 0; ; hops++) {
    const l = links(cur)?.find((x) => x.number === n && want.has(x.slug.toLowerCase()));
    if (!l) return start;
    if (!l.via) return cur;
    if (seen.has(l.via) || hops >= 8) return start;
    seen.add(l.via);
    cur = l.via;
  }
}

/** The daemon's PRTaskResult (protojson-style names). */
export interface PrTaskResult {
  threadId: string;
  viaThreadId?: string;
  sent: boolean;
  ordinal?: number;
  projectId?: string;
  worktreePath?: string;
  createdWorktree?: boolean;
  cloned?: boolean;
}

const label = (t: { id: string; name: string }): string => (t.name ? `${t.name} (${t.id})` : t.id);

const forkRefusal = (n: number, slug: string): ConnectError =>
  new ConnectError(
    `#${String(n)} comes from a fork and no worktree of ${slug} has its head checked out: check it out (for example \`gh pr checkout ${String(n)}\` in a worktree) and pass --worktree`,
    Code.FailedPrecondition,
  );

/** The daemon's refusal of a push task without a head branch (pickPRWorktree). */
const noHeadRefusal = (n: number): ConnectError => new ConnectError(`#${String(n)} has no head branch to check out: pass --worktree`, Code.FailedPrecondition);

/** The registry's thread id resolution (command.ResolveID): the id, else the one id ending in a 4+ character suffix. */
function resolveThreadId(ref: string, ids: string[]): string {
  if (ref.length < 4 || ref.startsWith("s-") || ids.includes(ref)) return ref;
  const matches = ids.filter((id) => id.endsWith(ref)).sort();
  if (matches.length === 1) return matches[0] ?? ref;
  if (matches.length === 0) throw new ConnectError(`no thread id ends in "${ref}"`, Code.NotFound);
  throw new CommandError("invalid", `"${ref}" is ambiguous: ${String(matches.length)} thread ids end in it (${matches.join(", ")}); give more characters`);
}

/** A registry entry, as world.ts's registry() takes them. */
interface Command {
  cmd: { name: string; title: string; category: string; description: string; keybindings: string[]; noPalette?: boolean; args: { name: string; type: ArgType; required: boolean; description: string; enumValues?: string[] }[] };
  when: (ctx: UiContext | undefined) => boolean;
  run: (ctx: UiContext | undefined, args: Record<string, string>) => Promise<InvokeOut>;
}

export function prTaskCommand(d: PrTaskDeps): Command {
  return {
    cmd: {
      name: "pr.task",
      noPalette: true,
      title: "Hand Pull Request Task to Thread",
      category: "Pull Request",
      description:
        "Have a thread handle one of a pull request's open items: fix failing checks, address requested changes or unresolved conversations, resolve conflicts, bring the branch up to date, or review someone's pull request (read-only).",
      keybindings: [],
      args: [
        { name: "repo-slug", type: ArgType.STRING, required: true, description: 'GitHub repository, "owner/name"' },
        { name: "number", type: ArgType.INT, required: true, description: "Pull request number" },
        { name: "kind", type: ArgType.ENUM, required: true, description: "The task", enumValues: [...PR_TASK_KINDS] },
        { name: "thread", type: ArgType.STRING, required: false, description: "Send the task into this thread instead of starting one" },
        { name: "worktree", type: ArgType.PATH, required: false, description: "Worktree to start the thread in (default: the pull request's branch in a clone of repo-slug)" },
        { name: "model", type: ArgType.ENUM, required: false, description: "Model (default: settings threads.default_model, else Claude's default)", enumValues: MODEL_VALUES },
        { name: "effort", type: ArgType.ENUM, required: false, description: "Effort level (default: settings threads.default_effort, else Claude's default)", enumValues: ["low", "medium", "high", "xhigh", "max"] },
        { name: "focus", type: ArgType.BOOL, required: false, description: "Select the new thread in every window" },
      ],
    },
    when: () => true,
    run: async (_ctx, args) => {
      if (d.delayMs() > 0) await new Promise((r) => setTimeout(r, d.delayMs()));
      const slug = (args["repo-slug"] ?? "").trim();
      const n = Number(args.number);
      const kind = args.kind as (typeof PR_TASK_KINDS)[number];
      if (!slug) throw new CommandError("invalid", "repo-slug is required");
      if (!Number.isInteger(n) || n <= 0) throw new CommandError("invalid", "number must be a positive pull request number");
      if (!PR_TASK_KINDS.includes(kind)) throw new CommandError("invalid", `kind must be one of ${PR_TASK_KINDS.join(", ")}`);
      // Args only a new thread uses are refused with thread before anything is read.
      const threadId = args.thread ? resolveThreadId(args.thread, d.threadIds()) : "";
      if (threadId) {
        const extra = NEW_THREAD_ARGS.find((a) => args[a] !== undefined);
        if (extra) throw new CommandError("invalid", `${extra} is for a new thread; with thread the task goes into that thread as it is`);
      }
      if (d.failNext.delete("pr.task")) throw forkRefusal(n, slug);
      const push = kind !== "review-request";
      // readPR: a failed read keeps its code under "read #N"; no pull request is NotFound.
      let pr: TaskPullRequest | undefined;
      try {
        pr = d.pullRequest(slug, n, push);
      } catch (err) {
        const ce = ConnectError.from(err);
        throw new ConnectError(`read #${String(n)}: ${ce.rawMessage}`, ce.code);
      }
      if (!pr) throw new ConnectError(`pull request ${slug}#${String(n)} was not returned`, Code.NotFound);
      const head = pr.headRef ?? "";
      const cross = pr.isCrossRepository ?? false;
      // GitHub's current name for the repository; clones match it too.
      const canon = pr.repoSlug || slug;
      const prompt = (followUp: boolean, from = ""): string => {
        const lead = followUp ? `Follow-up task: ${LEADS[kind].charAt(0).toLowerCase()}${LEADS[kind].slice(1)}` : LEADS[kind];
        const forwarded = from ? ` The user sent this task from thread \`${from}\`.` : "";
        return `${lead} PR \`${canon}#${String(n)}\` (branch \`${head}\`).${forwarded}`;
      };

      // --thread: a follow-up message, no focus; forwarded to the link's owner.
      if (threadId) {
        const t = d.thread(threadId);
        if (!t) throw new ConnectError(`find thread ${threadId}: thread ${threadId} not found`, Code.NotFound);
        const ownerId = linkOwner(t.id, [slug, canon], n, (id) => d.thread(id)?.linkedPullRequests);
        const owner = ownerId === t.id ? undefined : d.thread(ownerId);
        const to = owner ?? t;
        const ordinal = d.send(to.id, prompt(true, owner ? label(t) : ""));
        if (owner) d.addNote(t.id, `Sent to ${label(owner)}: ${TITLES[kind]} (#${String(n)})`);
        const result: PrTaskResult = { threadId: to.id, ...(owner ? { viaThreadId: t.id } : {}), sent: true, ...(ordinal > 0 ? { ordinal } : {}) };
        const next = ordinal > 0 ? ` (#${String(ordinal)}); wait with: code-foundry thread wait ${to.id} --after ${String(ordinal)}` : "";
        return { message: `Sent to ${label(to)}${owner ? ` for ${label(t)}` : ""}${next}`, resultJson: JSON.stringify(result) };
      }

      // A new thread on the head (checkedOutIn: a same-repository head by branch name, a
      // fork's by commit or by an upstream on a remote other than origin).
      const onHead = (w: TaskWorktree): boolean => {
        if (!cross) return head !== "" && w.branch === head;
        if (pr.headSha && w.head.toLowerCase() === pr.headSha.toLowerCase()) return true;
        if (!head || !w.status.upstream.endsWith(`/${head}`)) return false;
        const remote = w.status.upstream.slice(0, -head.length - 1);
        return remote !== "" && remote !== "origin";
      };
      // An explicit worktree is used as is (the daemon resolves its project).
      if (args.worktree) {
        const owner = d.projects().find((p) => p.worktrees.some((w) => w.path === args.worktree));
        const defaults = d.defaults();
        const t = d.startThread(owner?.id ?? "", args.worktree, args.model ?? defaults.model, args.effort ?? defaults.effort, prompt(false));
        if (args.focus !== "false") d.focusThread(t.id);
        // As the daemon's PRTaskResult, empty and false fields are left out.
        const result: PrTaskResult = { threadId: t.id, sent: false, ...(owner ? { projectId: owner.id } : {}), worktreePath: args.worktree };
        return { message: `Started thread ${label(t)} for PR #${String(n)}`, resultJson: JSON.stringify(result) };
      }
      // Clones match the argument or GitHub's current name (a renamed repository).
      const clonesOf = (s: string) => d.projects().filter((p) => p.githubSlug !== "" && p.githubSlug.toLowerCase() === s.toLowerCase());
      let clones = clonesOf(slug).length > 0 ? clonesOf(slug) : clonesOf(canon);
      let cloned = false;
      if (clones.length === 0) {
        // Refused before cloning when a fresh clone could not place it either.
        if (push && head === "") throw noHeadRefusal(n);
        if (push && cross) {
          throw new ConnectError(
            `#${String(n)} comes from a fork and ${canon} is not a project yet: clone it (\`code-foundry project clone ${canon}\`), check out the head in a worktree there (\`gh pr checkout ${String(n)}\`), and pass --worktree`,
            Code.FailedPrecondition,
          );
        }
        const [owner = "", name = ""] = canon.split("/");
        const path = `${PROJECTS}/${owner}/${name}`;
        if (cloneExists(path) || d.projects().some((p) => p.path.toLowerCase() === path.toLowerCase())) {
          throw new ConnectError(`clone ${canon}: ${path} already exists`, Code.AlreadyExists);
        }
        clones = [d.addClone(owner, name, path)];
        cloned = true;
      }
      let target: { projectId: string; path: string } | null = null;
      for (const p of clones) {
        const w = p.worktrees.find(onHead);
        if (w) {
          target = { projectId: p.id, path: w.path };
          break;
        }
      }
      const first = clones[0];
      let createdWorktree = false;
      if (!target && first) {
        if (head !== "" && !cross) {
          target = { projectId: first.id, path: d.addWorktree(first, head, pr.headSha ?? "c0ffee00").path };
          createdWorktree = true;
        } else if (push) {
          throw head === "" ? noHeadRefusal(n) : forkRefusal(n, first.githubSlug);
        } else {
          target = { projectId: first.id, path: first.worktrees.find((w) => w.isMain)?.path ?? first.path };
        }
      }
      if (!target) throw new CommandError("unavailable", `no registered project is a clone of ${slug}`);
      const defaults = d.defaults();
      const t = d.startThread(target.projectId, target.path, args.model ?? defaults.model, args.effort ?? defaults.effort, prompt(false));
      if (args.focus !== "false") d.focusThread(t.id);
      const result: PrTaskResult = { threadId: t.id, sent: false, projectId: target.projectId, worktreePath: target.path, ...(createdWorktree ? { createdWorktree } : {}), ...(cloned ? { cloned } : {}) };
      const started = `started thread ${label(t)} for PR #${String(n)}`;
      return { message: cloned ? `Cloned ${canon} and ${started}` : `S${started.slice(1)}`, resultJson: JSON.stringify(result) };
    },
  };
}
