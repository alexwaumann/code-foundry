/**
 * Mock GitOpsService behaviour for the mock daemon: the git.*, pr.*, worktree.open.editor,
 * worktree.reveal and view.open.url commands run a fake operation per worktree (one at a
 * time per worktree, like the real store), publishing queued/started/finished GitOpsEvents
 * that the mock's EventService carries. Invoke resolves when the op finishes: success
 * returns the GitOp as result_json, failure throws a ConnectError carrying the GitOp as a
 * detail, exactly as the real daemon does.
 *
 * Controls (see server.ts): POST /__mock/gitops?fail=git.push&delay=800, GET /__mock/gitops.
 */
import { clone, create, toJsonString, type MessageInitShape } from "@bufbuild/protobuf";
import { timestampFromDate } from "@bufbuild/protobuf/wkt";
import { Code, ConnectError } from "@connectrpc/connect";
import { ArgType, type UiContext } from "../src/gen/codefoundry/v1/command_pb";
import { GitOpKind, GitOpSchema, GitOpState, type GitOp, type GitOpsEventSchema } from "../src/gen/codefoundry/v1/gitops_pb";

export type GitOpsEventInit = MessageInitShape<typeof GitOpsEventSchema>;
export interface InvokeOut {
  message: string;
  resultJson: string;
}

interface Wt {
  repoId: string;
  path: string;
  branch: string;
  githubSlug: string;
}

interface Outcome {
  summary: string;
  output: string;
  url?: string;
}

interface Spec {
  name: string;
  title: string;
  category: string;
  description: string;
  keybindings: string[];
  kind: GitOpKind;
  needsGitHub?: boolean;
  args?: { name: string; type: ArgType; description: string }[];
  label: (w: Wt | null, args: Record<string, string>) => string;
  ok: (w: Wt | null, args: Record<string, string>) => Outcome;
  fail: (w: Wt | null) => Outcome;
}

const base = (p: string) => p.replace(/\/+$/, "").split("/").pop() ?? p;
const PR = "https://github.com/awaumann/code-foundry/pull/128";
const worktreeArg = { name: "worktree", type: ArgType.PATH, description: "Worktree path (default: the active worktree)" };

const specs: Spec[] = [
  {
    name: "git.fetch", title: "Git: Fetch", category: "Git", description: "Fetch from the remote and prune deleted branches", keybindings: ["cmd+shift+f"], kind: GitOpKind.FETCH,
    label: (w) => `Fetch ${w?.branch ?? ""}`,
    ok: () => ({ summary: "fetched 2 updated refs", output: "$ git fetch --prune\nFrom github.com:awaumann/code-foundry\n   3c3c465..8d9e0f1  main       -> origin/main\n * [new branch]      feat/x     -> origin/feat/x\n" }),
    fail: () => ({ summary: "unable to access 'https://github.com/awaumann/code-foundry.git/': Could not resolve host: github.com", output: "$ git fetch --prune\nfatal: unable to access 'https://github.com/awaumann/code-foundry.git/': Could not resolve host: github.com\n(exit 128)\n" }),
  },
  {
    name: "git.pull", title: "Git: Pull", category: "Git", description: "Pull the upstream branch (fast-forward only unless --rebase)", keybindings: ["cmd+shift+u"], kind: GitOpKind.PULL,
    args: [{ name: "rebase", type: ArgType.BOOL, description: "Rebase instead of fast-forward" }],
    label: (w, a) => `Pull ${a.rebase === "true" ? "--rebase " : ""}${w?.branch ?? ""}`,
    ok: () => ({ summary: "fast-forwarded: 3 files changed, 12 insertions(+)", output: "$ git pull --ff-only\nUpdating 3c3c465..8d9e0f1\nFast-forward\n 3 files changed, 12 insertions(+)\n" }),
    fail: () => ({ summary: "Not possible to fast-forward, aborting.", output: "$ git pull --ff-only\nhint: Diverging branches can't be fast-forwarded, you need to either:\nhint:\nhint: \tgit merge --no-ff\nhint:\nhint: or:\nhint:\nhint: \tgit rebase\nfatal: Not possible to fast-forward, aborting.\n(exit 128)\n" }),
  },
  {
    name: "git.push", title: "Git: Push", category: "Git", description: "Push the current branch (sets origin/<branch> as upstream if missing)", keybindings: ["cmd+shift+k"], kind: GitOpKind.PUSH,
    args: [{ name: "force-with-lease", type: ArgType.BOOL, description: "Force, if the remote is where we last saw it" }],
    label: (w, a) => `${a["force-with-lease"] === "true" ? "Force-push" : "Push"} ${w?.branch ?? ""}`,
    ok: (w) => ({ summary: `pushed ${w?.branch ?? ""} to origin`, output: `$ git push\nTo github.com:awaumann/code-foundry.git\n   3c3c465..8d9e0f1  ${w?.branch ?? ""} -> ${w?.branch ?? ""}\n` }),
    fail: (w) => {
      const b = w?.branch ?? "main";
      return {
        summary: `[rejected] ${b} -> ${b} (fetch first)`,
        output: `$ git push\nTo github.com:awaumann/code-foundry.git\n ! [rejected]        ${b} -> ${b} (fetch first)\nerror: failed to push some refs to 'github.com:awaumann/code-foundry.git'\nhint: Updates were rejected because the remote contains work that you do not\nhint: have locally. Integrate the remote changes (e.g. 'git pull ...') before pushing again.\n(exit 1)\n`,
      };
    },
  },
  {
    name: "pr.create", title: "Create Pull Request", category: "Pull Request", description: "Push the branch and open a GitHub pull request (gh pr create)", keybindings: [], kind: GitOpKind.PR_CREATE, needsGitHub: true,
    args: [
      { name: "title", type: ArgType.STRING, description: "Title (default: the last commit's subject)" },
      { name: "body", type: ArgType.STRING, description: "Description" },
      { name: "draft", type: ArgType.BOOL, description: "Open as a draft" },
      { name: "base", type: ArgType.STRING, description: "Base branch" },
    ],
    label: (w) => `Create PR for ${w?.branch ?? ""}`,
    ok: (w) => ({ summary: "created pull request #128", url: PR, output: `$ git push -u origin ${w?.branch ?? ""}\n * [new branch]      ${w?.branch ?? ""} -> ${w?.branch ?? ""}\n$ gh pr create --head ${w?.branch ?? ""} --title 'Sidebar tree' --body ''\n${PR}\n` }),
    fail: () => ({ summary: "GraphQL: No commits between main and feat/sidebar (createPullRequest)", output: "$ gh pr create\npull request create failed: GraphQL: No commits between main and feat/sidebar (createPullRequest)\n(exit 1)\n" }),
  },
  {
    name: "pr.open", title: "Open Pull Request in Browser", category: "Pull Request", description: "Open the branch's pull request on GitHub", keybindings: [], kind: GitOpKind.PR_OPEN, needsGitHub: true,
    label: (w) => `Open PR for ${w?.branch ?? ""}`,
    ok: () => ({ summary: "opened pull request #128", url: PR, output: `$ gh pr view feat/sidebar --json url,number --jq .url\n${PR}\n$ open ${PR}\n` }),
    fail: (w) => ({ summary: `no pull requests found for branch "${w?.branch ?? ""}"`, output: `$ gh pr view\nno pull requests found for branch "${w?.branch ?? ""}"\n(exit 1)\n` }),
  },
  {
    name: "worktree.open.editor", title: "Open Worktree in Editor", category: "Worktree", description: "Open the worktree in the configured editor", keybindings: ["cmd+shift+o"], kind: GitOpKind.OPEN_EDITOR,
    label: (w) => `Open ${base(w?.path ?? "")} in editor`,
    ok: (w) => ({ summary: `opened ${base(w?.path ?? "")} in cursor`, output: `$ cursor ${w?.path ?? ""}\n` }),
    fail: () => ({ summary: 'no editor found: set the editor command (for example "code" or "open -a Zed")', output: "no editor found\n" }),
  },
  {
    name: "worktree.reveal", title: "Reveal Worktree in Finder", category: "Worktree", description: "Show the worktree folder in Finder", keybindings: [], kind: GitOpKind.REVEAL,
    label: (w) => `Reveal ${base(w?.path ?? "")} in Finder`,
    ok: (w) => ({ summary: `revealed ${w?.path ?? ""} in Finder`, output: `$ open -R ${w?.path ?? ""}\n` }),
    fail: () => ({ summary: "open: exit 1", output: "$ open -R\n(exit 1)\n" }),
  },
  {
    name: "view.open.url", title: "Open URL in Browser", category: "View", description: "Open an http(s) URL in the default browser", keybindings: [], kind: GitOpKind.OPEN_URL,
    args: [{ name: "url", type: ArgType.STRING, description: "http or https URL" }],
    label: (_w, a) => `Open ${a.url ?? ""}`,
    ok: (_w, a) => ({ summary: `opened ${a.url ?? ""}`, url: a.url ?? "", output: `$ open ${a.url ?? ""}\n` }),
    fail: () => ({ summary: "open: exit 1", output: "(exit 1)\n" }),
  },
];

export class MockGitOps {
  /** Finished ops newest first, after active ones (like the real snapshot). */
  private active: GitOp[] = [];
  private finished: GitOp[] = [];
  private lanes = new Map<string, Promise<unknown>>();
  private seq = 0;
  /** Command names whose next run fails. */
  failNext = new Set<string>();
  delayMs = 900;

  constructor(private readonly publish: (e: GitOpsEventInit) => void) {}

  reset(): void {
    this.active = [];
    this.finished = [];
    this.lanes.clear();
    this.failNext.clear();
    this.delayMs = 900;
  }

  snapshot(): GitOpsEventInit {
    return { event: { case: "snapshot", value: { ops: [...this.active, ...this.finished] } } };
  }

  summaries(): { id: string; title: string; state: string; summary: string }[] {
    return [...this.active, ...this.finished].map((o) => ({ id: o.id, title: o.title, state: GitOpState[o.state], summary: o.summary }));
  }

  /** Registry entries; `worktreeOf` resolves the (context or explicit) worktree. */
  entries(worktreeOf: (path: string) => Wt | null) {
    const target = (ctx: UiContext | undefined, args: Record<string, string>) => worktreeOf(args.worktree || ctx?.activeWorktreePath || "");
    return specs.map((s) => ({
      cmd: {
        name: s.name, title: s.title, category: s.category, description: s.description, keybindings: s.keybindings,
        args: [...(s.kind === GitOpKind.OPEN_URL ? [] : [{ ...worktreeArg, required: false }]), ...(s.args ?? []).map((a) => ({ ...a, required: s.kind === GitOpKind.OPEN_URL }))],
      },
      when: (ctx: UiContext | undefined) => {
        if (s.kind === GitOpKind.OPEN_URL) return true;
        const w = target(ctx, {});
        return w !== null && (!s.needsGitHub || w.githubSlug !== "");
      },
      run: (ctx: UiContext | undefined, args: Record<string, string>): Promise<InvokeOut> => this.run(s, s.kind === GitOpKind.OPEN_URL ? null : target(ctx, args), args),
    }));
  }

  private run(s: Spec, w: Wt | null, args: Record<string, string>): Promise<InvokeOut> {
    const now = new Date();
    const op = create(GitOpSchema, {
      id: `op-${String(++this.seq)}`, kind: s.kind, state: GitOpState.QUEUED, title: s.label(w, args).trim(),
      worktreePath: w?.path ?? "", repoId: w?.repoId ?? "", branch: w?.branch ?? "", queuedAt: timestampFromDate(now),
    });
    const fail = this.failNext.delete(s.name);
    const key = w?.path ?? "";
    const prev = this.lanes.get(key);
    this.active.push(op);
    if (prev) this.publish({ event: { case: "queued", value: clone(GitOpSchema, op) } });
    const job = (prev ?? Promise.resolve()).catch(() => undefined).then(async () => {
      const started = new Date();
      op.state = GitOpState.RUNNING;
      op.startedAt = timestampFromDate(started);
      this.publish({ event: { case: "started", value: clone(GitOpSchema, op) } });
      await new Promise((r) => setTimeout(r, this.delayMs));
      const out = fail ? s.fail(w) : s.ok(w, args);
      const end = new Date();
      Object.assign(op, { state: fail ? GitOpState.FAILED : GitOpState.SUCCEEDED, summary: out.summary, output: out.output, url: out.url ?? "", finishedAt: timestampFromDate(end), durationMs: BigInt(end.getTime() - started.getTime()) });
      this.active = this.active.filter((o) => o !== op);
      this.finished = [op, ...this.finished].slice(0, 20);
      this.publish({ event: { case: "finished", value: clone(GitOpSchema, op) } });
      if (fail) {
        throw new ConnectError(`${op.title} failed: ${op.summary}\n\n${op.output}`, Code.Unknown, undefined, [{ desc: GitOpSchema, value: op }]);
      }
      const message = op.url && !op.summary.includes(op.url) ? `${op.summary}: ${op.url}` : op.summary;
      return { message, resultJson: toJsonString(GitOpSchema, op) };
    });
    this.lanes.set(key, job);
    void job.catch(() => undefined).finally(() => {
      if (this.lanes.get(key) === job) this.lanes.delete(key);
    });
    return job;
  }
}
