import { RotateCcw } from "lucide-react";
import { tildify } from "@/lib/path";
import { cn } from "@/lib/utils";
import { resetTerminal } from "@/shell/terminalActions";
import { useTerminalCwdHint } from "@/shell/terminalTab";

/**
 * The quiet hint a terminal shows once its shell has left its thread's directory
 * (docs/notes/shell-model.md, "Terminals"): "· thread is in <dir> · Reset". Reset starts a fresh
 * shell in the thread's directory under the same tab or quick slot (terminal.reset); nothing
 * resets by itself. It draws nothing while the shell is where its thread is, and for a terminal
 * of no thread.
 *
 * The quick terminal's header draws it right-aligned; a linked terminal tab draws it in the row
 * under its strip (PR 12's linked row: `<TerminalCwdHint terminalId={tab.params.terminal} />` at
 * the row's right end). Its directory shortens first, so Reset always shows.
 */
export function TerminalCwdHint({ terminalId, className }: { terminalId: string; className?: string }) {
  const hint = useTerminalCwdHint(terminalId);
  if (!hint) return null;
  return (
    <span className={cn("flex min-w-0 items-center gap-1 text-caption text-cf-text-muted", className)} data-testid="terminal-cwd-hint">
      <span aria-hidden>·</span>
      <span className="min-w-0 truncate">thread is in {tildify(hint.threadDir)}</span>
      <span aria-hidden>·</span>
      <button
        type="button"
        className="flex shrink-0 items-center gap-1 rounded-sm px-1 text-cf-text-muted outline-none hover:bg-cf-control-hover hover:text-cf-text focus-visible:ring-1 focus-visible:ring-cf-focus"
        data-testid="terminal-cwd-reset"
        onClick={() => void resetTerminal(terminalId)}
      >
        <RotateCcw className="size-3" aria-hidden />
        Reset
      </button>
    </span>
  );
}
