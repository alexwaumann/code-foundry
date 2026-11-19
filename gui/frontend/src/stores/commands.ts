import { create } from "zustand";
import { notify } from "@/lib/notify";
import { confirmationOf, confirmButtonLabel, invokeCommand, listCommands, type CommandView, type InvokeResultView, type UiContextView } from "@/api/command";
import { invalidateOnTransportError } from "@/api/endpoint";
import { isGitOpFailure, isGitOpResult } from "@/api/gitops";
import { errorMessage, isAbort } from "@/api/stream";
import { guardCommand } from "./commandGuards";
import { confirmPresenter, requestConfirm, secondStagePresenter, type ConfirmPresenter } from "./confirm";
import { contextKey, getUiContext } from "./context";
import { useLayoutStore } from "./layout";
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

/** A command's first chord as the user bound it; "" when none. */
export function useCommandChord(name: string): string {
  return useCommandsStore((s) => s.commands.find((c) => c.name === name)?.keybindings[0] ?? "");
}

/** The chord the user bound to dictation.toggle; "" when none, which is the default. */
export function useDictateChord(): string {
  return useCommandsStore((s) => s.commands.find((c) => c.name === "dictation.toggle")?.keybindings[0] ?? "");
}

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
 * asks again (the command's secondStagePresenter, else the confirm dialog) and merges its
 * args (force) into the re-invoke; a confirmation's bind args
 * (the digest of the consent text shown) are merged too. Resolves null when the
 * user declines (or a declined second stage's result: what the command already did);
 * other errors reject. `caller` names who asked for it (a plugin's InvokeCommand
 * intent), shown in the dialog. `ask` takes every question instead of the dialogs above: a
 * page's (stores/bridgeHost.ts) gets the guarded confirm dialog and no command's own
 * presenter, so what it asks never counts on what the app's own dialogs accepted. `signal`
 * aborts the call. `asked`: the app's own dialog already put this exact call to the user
 * (the pull request page's merge dialog), so the first invoke goes confirmed and the
 * command's own question is not asked again; a second stage still asks. Never for a call
 * the user did not make in that dialog (a page's or a plugin's).
 */
export async function invokeConfirmed(
  name: string,
  args: Record<string, string> = {},
  ctx: UiContextView = getUiContext(),
  caller?: string,
  opts: { ask?: ConfirmPresenter; signal?: AbortSignal; asked?: boolean } = {},
): Promise<Awaited<ReturnType<typeof invokeCommand>> | null> {
  let callArgs = args;
  let confirmed = opts.asked === true;
  for (let stage = 0; ; stage++) {
    try {
      const sent = confirmed || opts.signal ? invokeCommand(name, ctx, callArgs, undefined, { confirmed, ...(opts.signal ? { signal: opts.signal } : {}) }) : invokeCommand(name, ctx, callArgs);
      return await sent;
    } catch (err) {
      const confirm = confirmationOf(err);
      if (!confirm || stage >= MAX_CONFIRM_STAGES) throw err;
      // A second stage applies only to the command invoked (not one plugin.act ran for it).
      if (confirm.args && confirm.command !== name) throw err;
      const title = confirm.title || (useCommandsStore.getState().commands.find((c) => c.name === name)?.title ?? name);
      const ask = opts.ask ?? (confirm.args ? secondStagePresenter(name) : confirmPresenter(name)) ?? requestConfirm;
      const confirmLabel = confirmButtonLabel(title, confirm.confirmLabel);
      const req = { title, message: confirm.message, confirmLabel, command: name, args: callArgs, ...(caller ? { caller } : {}), ...(confirm.tone ? { tone: confirm.tone } : {}) };
      const yes = await ask(req);
      if (!yes) return confirm.declined ?? null;
      confirmed = true;
      if (confirm.args) callArgs = { ...callArgs, ...confirm.args };
      // Binds the yes to what was shown (plugin consent), for the command invoked only.
      if (confirm.bind && confirm.command === name) callArgs = { ...callArgs, ...confirm.bind };
    }
  }
}

/**
 * Commands whose success shows by itself wherever they are run from, so they never toast
 * it: another app or window comes forward (Finder, the editor, the browser), a terminal tab
 * opens, the thread stops. The CLI still prints the message. docs/notes/toast-success-rule.md.
 */
const SHOWS_ITSELF: ReadonlySet<string> = new Set([
  "terminal.new",
  "thread.interrupt",
  "worktree.reveal",
  "workspace.reveal",
  "settings.reveal",
  "worktree.open.editor",
  "workspace.open.editor",
  "view.open.url",
]);

/** Longest daemon message that is the success toast's title by itself (one line, it says what happened). */
const TITLE_MAX = 64;

/**
 * The success toast for a command's message: a short one-line message is what happened, so
 * it is the title ("Requested a review from ana on #5"), its first letter raised (daemon
 * messages are CLI sentences, often lower case, some with a full stop); a longer one goes
 * under the command's title.
 */
export function commandSuccessNotice(title: string, message: string): { title: string; description?: string } {
  const line = message.trim().replace(/\.$/, "");
  if (line !== "" && !line.includes("\n") && line.length <= TITLE_MAX) return { title: line.charAt(0).toUpperCase() + line.slice(1) };
  return { title, description: message };
}

/** Where a command was run from, for its success toast (docs/notes/toast-success-rule.md). */
export interface CommandSource {
  /**
   * Run from a control that stays on screen and shows the result itself (an inline rename,
   * a switch, a button whose row changes): no success toast. Left out (a menu, the
   * palette, a keybinding, a dialog that closes elsewhere), the success is toasted.
   */
  inView?: boolean;
}

/**
 * Invokes a command with the current context; reports a failure as a toast, and a success
 * unless `source` says the screen shows it. A command the daemon wants confirmed
 * (ConfirmationRequired) opens the confirm dialog and runs again with confirmed set if the
 * user agrees; declining returns false quietly.
 */
export async function runCommand(name: string, args: Record<string, string> = {}, ctx: UiContextView = getUiContext(), source: CommandSource = {}): Promise<boolean> {
  return (await runCommandForResult(name, args, { ctx, ...source })) !== null;
}

/**
 * runCommand that hands back the command's result (null when it failed or the user
 * declined). `quiet` skips the success toast, for callers that report the result their
 * own way, and so does `inView` (CommandSource); failures are toasted, after `onError` (for
 * callers that also show the failure in place), unless `expected` says the failure is one
 * the caller handles itself. `asked`: the caller's own dialog already asked the user for
 * exactly this call (invokeConfirmed).
 */
export async function runCommandForResult(
  name: string,
  args: Record<string, string> = {},
  opts: { ctx?: UiContextView; quiet?: boolean; onError?: (message: string) => void; expected?: (err: unknown) => boolean; caller?: string; asked?: boolean } & CommandSource = {},
): Promise<InvokeResultView | null> {
  const title = useCommandsStore.getState().commands.find((c) => c.name === name)?.title ?? name;
  try {
    const ctx = opts.ctx ?? getUiContext();
    // A plugin's call (`caller`) is not the user's: what it would end is kept, not asked about.
    const guarded = opts.caller === undefined ? guardCommand(name, args, ctx) : true;
    if (guarded !== true && !(await guarded)) return null;
    // `asked` is the app's own dialog's yes, never a caller's (invokeConfirmed).
    const res = await invokeConfirmed(name, args, ctx, opts.caller, { asked: opts.asked === true && opts.caller === undefined });
    if (!res) return null;
    // Git operations report through their own toast (gitops events); skip the duplicate.
    const silent = opts.quiet || opts.inView || SHOWS_ITSELF.has(name);
    if (!silent && res.message && !isGitOpResult(res.resultJson)) notify({ level: "success", ...commandSuccessNotice(title, res.message) });
    return res;
  } catch (err) {
    opts.onError?.(errorMessage(err));
    if (!isGitOpFailure(err) && !opts.expected?.(err)) notify({ level: "error", title: `${title} failed`, description: errorMessage(err) });
    return null;
  } finally {
    void refreshCommands();
  }
}

/**
 * Re-lists commands whenever the derived UiContext changes (debounced; the focused tab and
 * the keyboard decide which terminal is active), and when the selected thread's state
 * changes (availability often depends on it).
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
  const unsubs = [useUiStore.subscribe(check), useTerminalsStore.subscribe(check), useProjectsStore.subscribe(check), useThreadsStore.subscribe(check), useSubagentViewStore.subscribe(check), useLayoutStore.subscribe(check)];
  // The keyboard entering or leaving a quick terminal changes the context's terminal.
  if (typeof document !== "undefined") {
    document.addEventListener("focusin", check);
    unsubs.push(() => {
      document.removeEventListener("focusin", check);
    });
  }
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
