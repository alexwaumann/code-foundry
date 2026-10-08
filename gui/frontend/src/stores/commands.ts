import { create } from "zustand";
import { toast } from "sonner";
import { invokeCommand, listCommands, type CommandView, type UiContextView } from "@/api/command";
import { invalidateOnTransportError } from "@/api/endpoint";
import { errorMessage, isAbort } from "@/api/stream";
import { contextKey, getUiContext } from "./context";
import { useReposStore } from "./repos";
import { useSessionsStore } from "./sessions";
import { useTerminalsStore } from "./terminals";
import { useUiStore } from "./ui";

interface CommandsState {
  /** Commands available in `contextKey`'s context, as returned by CommandService.List. */
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
    const fresh = await listCommands(ctx, { signal: ctl.signal });
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

/** Invokes a command with the current context; reports the result as a toast. */
export async function runCommand(name: string, args: Record<string, string> = {}, ctx: UiContextView = getUiContext()): Promise<boolean> {
  const title = useCommandsStore.getState().commands.find((c) => c.name === name)?.title ?? name;
  try {
    const res = await invokeCommand(name, ctx, args);
    if (res.message) toast.success(res.message);
    return true;
  } catch (err) {
    toast.error(`${title} failed`, { description: errorMessage(err) });
    return false;
  } finally {
    void refreshCommands();
  }
}

/**
 * Re-lists commands whenever the derived UiContext changes (debounced), and when the
 * selected terminal's or session's state changes (availability often depends on it).
 */
export function startCommandSync(debounceMs = 60): () => void {
  let lastKey = "";
  let lastState = "";
  let timer: ReturnType<typeof setTimeout> | undefined;
  const check = () => {
    const ctx = getUiContext();
    const sel = useUiStore.getState().selection;
    const state =
      sel.kind === "terminal"
        ? (useTerminalsStore.getState().byId[sel.id]?.state ?? "")
        : sel.kind === "session"
          ? (useSessionsStore.getState().byId[sel.id]?.state ?? "")
          : "";
    const key = contextKey(ctx);
    if (key === lastKey && state === lastState) return;
    lastKey = key;
    lastState = state;
    clearTimeout(timer);
    timer = setTimeout(() => void refreshCommands(ctx), debounceMs);
  };
  const unsubs = [useUiStore.subscribe(check), useTerminalsStore.subscribe(check), useReposStore.subscribe(check), useSessionsStore.subscribe(check)];
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
