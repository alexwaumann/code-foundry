import { create } from "zustand";
import { toast } from "sonner";
import { confirmationOf, confirmButtonLabel, invokeCommand, listCommands, type CommandView, type InvokeResultView, type UiContextView } from "@/api/command";
import { invalidateOnTransportError } from "@/api/endpoint";
import { isGitOpFailure, isGitOpResult } from "@/api/gitops";
import { errorMessage, isAbort } from "@/api/stream";
import { confirmPresenter, requestConfirm } from "./confirm";
import { contextKey, getUiContext } from "./context";
import { useProjectsStore } from "./projects";
import { useSubagentViewStore } from "./subagentView";
import { useThreadsStore } from "./threads";
import { useTerminalsStore } from "./terminals";
import { useUiStore } from "./ui";

interface CommandsState {
  /**
   * Every command, with `available` for `contextKey`'s context, as returned by
   * CommandService.List (include_unavailable). Consumers filter: see isStartable in
   * keys/bindings.ts.
   */
  commands: readonly CommandView[];
  contextKey: string | null;
  loading: boolean;
  error: string | null;
}

export const useCommandsStore = create<CommandsState>()(() => ({
  commands: [],
  contextKey: null,
  loading: false,
  error: null,
}));

let inflight: AbortController | null = null;

/** Lists commands for ctx. A newer call aborts an older one still in flight. */
export async function refreshCommands(ctx: UiContextView = getUiContext()): Promise<void> {
  inflight?.abort();
  const ctl = new AbortController();
  inflight = ctl;
  useCommandsStore.setState({ loading: true });
  try {
    // Unavailable ones too: thread.new's keybinding and title are needed with nothing
    // selected, where the project picker supplies the project (keys/bindings.ts).
    const fresh = await listCommands(ctx, { includeUnavailable: true, signal: ctl.signal });
    if (inflight !== ctl) return;
    // Keep the old array when nothing changed, so an open palette does not re-render
    // (and lose its highlighted item) on every refresh.
    const prev = useCommandsStore.getState().commands;
    const commands = JSON.stringify(prev) === JSON.stringify(fresh) ? prev : fresh;
    useCommandsStore.setState({ commands, contextKey: contextKey(ctx), loading: false, error: null });
  } catch (err) {
    if (isAbort(err) || inflight !== ctl) return;
    invalidateOnTransportError(err);
    useCommandsStore.setState({ loading: false, error: errorMessage(err) });
  } finally {
    if (inflight === ctl) inflight = null;
  }
}

/**
 * Resolves once the list for ctx has arrived (any refresh, not necessarily this
 * caller's: a newer refresh aborts older ones), or false after timeoutMs.
 */
export function whenListed(ctx: UiContextView, timeoutMs = 3000): Promise<boolean> {
  const key = contextKey(ctx);
  const ready = (s: CommandsState) => s.contextKey === key && !s.loading;
  if (ready(useCommandsStore.getState())) return Promise.resolve(true);
  return new Promise((resolve) => {
    const timer = setTimeout(() => {
      unsub();
      resolve(false);
    }, timeoutMs);
    const unsub = useCommandsStore.subscribe((s) => {
      if (!ready(s)) return;
      clearTimeout(timer);
      unsub();
      resolve(true);
    });
  });
}

/** How many confirmations one invoke asks at most (the command's own, then a second stage). */
const MAX_CONFIRM_STAGES = 3;

/**
 * Invokes a command; if the daemon wants it confirmed (ConfirmationRequired), opens the
 * confirm dialog (or the command's own presenter: confirmPresenter, e.g. the plugin
 * consent dialog) and invokes again with confirmed set when the user agrees. A
 * second-stage confirmation (one with args: deleting a worktree's uncommitted work)
 * asks again and merges its args (force) into the re-invoke; a confirmation's bind args
 * (the digest of the consent text shown) are merged too. Resolves null when the
 * user declines (or a declined second stage's result: what the command already did);
 * other errors reject. `caller` names who asked for it (a plugin's InvokeCommand
 * intent), shown in the dialog.
 */
export async function invokeConfirmed(
  name: string,
  args: Record<string, string> = {},
  ctx: UiContextView = getUiContext(),
  caller?: string,
): Promise<Awaited<ReturnType<typeof invokeCommand>> | null> {
  let callArgs = args;
  let confirmed = false;
  for (let stage = 0; ; stage++) {
    try {
      return await (confirmed ? invokeCommand(name, ctx, callArgs, undefined, { confirmed: true }) : invokeCommand(name, ctx, callArgs));
    } catch (err) {
      const confirm = confirmationOf(err);
      if (!confirm || stage >= MAX_CONFIRM_STAGES) throw err;
      // A second stage applies only to the command invoked (not one plugin.act ran for it).
      if (confirm.args && confirm.command !== name) throw err;
      const title = confirm.title || (useCommandsStore.getState().commands.find((c) => c.name === name)?.title ?? name);
      const ask = (confirm.args ? undefined : confirmPresenter(name)) ?? requestConfirm;
      const confirmLabel = confirmButtonLabel(title, confirm.confirmLabel);
      const yes = await ask({ title, message: confirm.message, confirmLabel, command: name, args: callArgs, ...(caller ? { caller } : {}) });
      if (!yes) return confirm.declined ?? null;
      confirmed = true;
      if (confirm.args) callArgs = { ...callArgs, ...confirm.args };
      // Binds the yes to what was shown (plugin consent), for the command invoked only.
      if (confirm.bind && confirm.command === name) callArgs = { ...callArgs, ...confirm.bind };
    }
  }
}

/**
 * Invokes a command with the current context; reports the result as a toast. A command
 * the daemon wants confirmed (ConfirmationRequired) opens the confirm dialog and runs
 * again with confirmed set if the user agrees; declining returns false quietly.
 */
export async function runCommand(name: string, args: Record<string, string> = {}, ctx: UiContextView = getUiContext()): Promise<boolean> {
  return (await runCommandForResult(name, args, { ctx })) !== null;
}

/**
 * runCommand that hands back the command's result (null when it failed or the user
 * declined). `quiet` skips the success toast, for callers that report the result their
 * own way; failures are toasted, after `onError` (for callers that also show the failure
 * in place), unless `expected` says the failure is one the caller handles itself.
 */
export async function runCommandForResult(
  name: string,
  args: Record<string, string> = {},
  opts: { ctx?: UiContextView; quiet?: boolean; onError?: (message: string) => void; expected?: (err: unknown) => boolean; caller?: string } = {},
): Promise<InvokeResultView | null> {
  const title = useCommandsStore.getState().commands.find((c) => c.name === name)?.title ?? name;
  try {
    const res = await invokeConfirmed(name, args, opts.ctx ?? getUiContext(), opts.caller);
    if (!res) return null;
    // Git operations report through their own toast (gitops events); skip the duplicate.
    if (!opts.quiet && res.message && !isGitOpResult(res.resultJson)) toast.success(res.message);
    return res;
  } catch (err) {
    opts.onError?.(errorMessage(err));
    if (!isGitOpFailure(err) && !opts.expected?.(err)) toast.error(`${title} failed`, { description: errorMessage(err) });
    return null;
  } finally {
    void refreshCommands();
  }
}

/**
 * Re-lists commands whenever the derived UiContext changes (debounced; the terminals
 * store decides which bottom panel shell is active), and when the selected thread's
 * state changes (availability often depends on it).
 */
export function startCommandSync(debounceMs = 60): () => void {
  let lastKey = "";
  let lastState = "";
  let timer: ReturnType<typeof setTimeout> | undefined;
  const check = () => {
    const ctx = getUiContext();
    const sel = useUiStore.getState().selection;
    const state = sel.kind === "thread" ? (useThreadsStore.getState().byId[sel.id]?.state ?? "") : "";
    const key = contextKey(ctx);
    if (key === lastKey && state === lastState) return;
    lastKey = key;
    lastState = state;
    clearTimeout(timer);
    timer = setTimeout(() => void refreshCommands(ctx), debounceMs);
  };
  const unsubs = [useUiStore.subscribe(check), useTerminalsStore.subscribe(check), useProjectsStore.subscribe(check), useThreadsStore.subscribe(check), useSubagentViewStore.subscribe(check)];
  check();
  // Retry periodically while the list is failing (e.g. daemon restarting).
  const retry = setInterval(() => {
    if (useCommandsStore.getState().error) void refreshCommands();
  }, 5000);
  return () => {
    clearTimeout(timer);
    clearInterval(retry);
    for (const u of unsubs) u();
  };
}
