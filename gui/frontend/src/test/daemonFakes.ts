/**
 * A faked daemon for component tests: the command invokes the GUI makes (what the mock's
 * `invocations()` records in e2e), the confirmations it asks for, and the GitHub and worktree
 * detail reads the Projects pages watch. Wire it in with vi.mock, spreading the fakes over the
 * real module:
 *
 *   vi.mock("@/api/command", async (orig) => ({ ...(await orig<typeof import("@/api/command")>()), ...(await import("@/test/daemonFakes")).commandFakes }));
 *
 * Nothing here imports a store or a mocked module, so the factories may import it.
 */
import { create } from "@bufbuild/protobuf";
import { Code, ConnectError } from "@connectrpc/connect";
import type { CommandView, InvokeResultView, UiContextView } from "@/api/command";
import type { BranchPullRequestsView, RepoActivityView } from "@/api/gh";
import type { WorktreeDetailView } from "@/api/worktreeDetail";
import { ConfirmationRequiredSchema } from "@/gen/codefoundry/v1/command_pb";

/** One CommandService.Invoke the GUI made. */
export interface Invocation {
  name: string;
  args: Record<string, string>;
  context: UiContextView;
  confirmed: boolean;
}

/** What a faked command does: return a result, or throw (needsConfirm, a refusal). */
export type Handler = (inv: Invocation) => InvokeResultView | Promise<InvokeResultView>;

const OK: InvokeResultView = { message: "", resultJson: "" };

export const daemon = {
  invocations: [] as Invocation[],
  handlers: new Map<string, Handler>(),
  commands: [] as CommandView[],
  repoActivity: new Map<string, RepoActivityView>(),
  branchPullRequests: new Map<string, BranchPullRequestsView>(),
  worktreeDetail: new Map<string, WorktreeDetailView>(),
};

/** Forgets every invocation and handler (call in beforeEach). */
export function resetDaemon(): void {
  daemon.invocations.length = 0;
  daemon.handlers.clear();
  daemon.commands = [];
  daemon.repoActivity.clear();
  daemon.branchPullRequests.clear();
  daemon.worktreeDetail.clear();
}

/** The invocations of one command, in order. */
export function invocationsOf(name: string): Invocation[] {
  return daemon.invocations.filter((i) => i.name === name);
}

/** The last invocation of a command, or undefined. */
export function lastInvocation(name: string): Invocation | undefined {
  return invocationsOf(name).at(-1);
}

/** How the daemon asks for a confirmation: FailedPrecondition with a ConfirmationRequired detail. */
export function needsConfirm(c: { command: string; title?: string; message: string; args?: Record<string, string>; confirmLabel?: string }): ConnectError {
  const detail = create(ConfirmationRequiredSchema, { command: c.command, title: c.title ?? "", message: c.message, args: c.args ?? {}, confirmLabel: c.confirmLabel ?? "" });
  return new ConnectError(c.message, Code.FailedPrecondition, undefined, [{ desc: ConfirmationRequiredSchema, value: detail }]);
}

/** A command that asks once (the daemon's confirm), then runs `after` once confirmed. */
export function confirmFirst(command: string, message: string, after: Handler = () => OK): void {
  daemon.handlers.set(command, (inv) => {
    if (!inv.confirmed) throw needsConfirm({ command, message });
    return after(inv);
  });
}

/** A refusal the daemon answers with (the message shows in place or as a toast). */
export function refuse(message: string, code = Code.FailedPrecondition): ConnectError {
  return new ConnectError(message, code);
}

export const commandFakes = {
  invokeCommand: async (name: string, ctx: UiContextView, args: Record<string, string>, _conn?: unknown, opts: { confirmed?: boolean } = {}): Promise<InvokeResultView> => {
    const inv: Invocation = { name, args: { ...args }, context: ctx, confirmed: opts.confirmed ?? false };
    daemon.invocations.push(inv);
    const h = daemon.handlers.get(name);
    return h ? await h(inv) : OK;
  },
  listCommands: (): Promise<CommandView[]> => Promise.resolve(daemon.commands),
};

const notFound = (what: string) => Promise.reject(new ConnectError(`${what} not faked`, Code.NotFound));

export const ghFakes = {
  getRepoActivity: (slug: string): Promise<RepoActivityView> => Promise.resolve(daemon.repoActivity.get(slug) ?? { repoSlug: slug, defaultBranch: null }),
  getBranchPullRequests: (repoSlug: string, branch: string): Promise<BranchPullRequestsView> =>
    Promise.resolve(daemon.branchPullRequests.get(`${repoSlug.toLowerCase()}\u0000${branch}`) ?? { pullRequests: [], fetchedAtMs: null, lastError: "" }),
  getViewer: () => notFound("viewer"),
};

export const detailFakes = {
  getWorktreeDetail: (projectId: string, path: string): Promise<WorktreeDetailView> => {
    const d = daemon.worktreeDetail.get(`${projectId}\u0000${path}`);
    return d ? Promise.resolve(d) : notFound("worktree detail");
  },
};
