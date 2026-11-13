import { useEffect, useRef, useState, type KeyboardEvent } from "react";
import { X } from "lucide-react";
import { ContextMenuItem, ContextMenuSeparator } from "@/components/ui/context-menu";
import { Tip } from "@/components/ui/tooltip";
import { TerminalHost, type TerminalHostHandle } from "@/components/terminal/TerminalHost";
import { cn } from "@/lib/utils";
import { closeTabNow } from "@/shell/commands";
import { autoNameTab, endTabRename, forgetRan, renameAfterMenuCloses, renameTab, runAgain, terminalOfTab } from "@/shell/terminalActions";
import { useTerminalTabName } from "@/shell/terminalTab";
import type { TabEntry } from "@/stores/layout";
import { useTerminalsStore } from "@/stores/terminals";
import { TERMINAL_ICONS } from "./terminalIcons";

/** A terminal tab's icon: the kind of command that runs in it (lib/terminalName.ts). */
export function TerminalTabIcon({ tab, className }: { tab: TabEntry; className?: string }) {
  const Icon = TERMINAL_ICONS[useTerminalTabName(tab).icon];
  return <Icon className={className} aria-hidden />;
}

/**
 * A restored terminal's one quiet line (docs/notes/shell-model.md, "Terminals"): the command its
 * shell ran before the snooze, and "Run again" (also Enter on the line). It never reruns by
 * itself; running it (onRun), or × (onDismiss), drops the line: a terminal tab's `ran` param, a
 * quick terminal's `ran` (QuickTerminal.tsx).
 */
export function RanLine({ ran, onRun, onDismiss }: { ran: string; onRun: () => Promise<void>; onDismiss: () => void }) {
  const [busy, setBusy] = useState(false);
  const run = () => {
    if (busy) return;
    setBusy(true);
    void onRun().finally(() => {
      setBusy(false);
    });
  };
  const onKeyDown = (e: KeyboardEvent<HTMLDivElement>) => {
    if (e.key !== "Enter" || e.target !== e.currentTarget) return;
    e.preventDefault();
    run();
  };
  return (
    <div
      role="group"
      aria-label="Last command"
      tabIndex={0}
      className="flex shrink-0 items-center gap-2 border-b border-cf-divider px-3 py-1 text-caption text-cf-text-muted outline-none focus-visible:bg-cf-control-hover/40"
      data-testid="terminal-ran-line"
      onKeyDown={onKeyDown}
    >
      <span className="shrink-0">Last command</span>
      <code className="min-w-0 truncate text-code text-cf-text">{ran}</code>
      <button
        type="button"
        disabled={busy}
        className="shrink-0 rounded-sm px-1 text-cf-text-muted outline-none hover:bg-cf-control-hover hover:text-cf-text focus-visible:ring-1 focus-visible:ring-cf-focus"
        data-testid="terminal-run-again"
        onClick={run}
      >
        Run again
      </button>
      <Tip label="Dismiss">
        <button
          type="button"
          aria-label="Dismiss"
          className="ml-auto flex size-4 shrink-0 items-center justify-center rounded-sm text-cf-text-muted outline-none hover:bg-cf-control-hover hover:text-cf-text focus-visible:ring-1 focus-visible:ring-cf-focus"
          onClick={onDismiss}
        >
          <X className="size-3" aria-hidden />
        </button>
      </Tip>
    </div>
  );
}

/**
 * A terminal tab's body: its xterm, attached while the tab is its pane's active tab (the pane
 * mounts only that one), so a hidden terminal tab holds no Attach stream. A restored terminal
 * shows its last command first. A focus request lands on the wrapper and goes to the xterm.
 */
export function TerminalTabBody({ tab }: { tab: TabEntry }) {
  const id = terminalOfTab(tab);
  const ref = useRef<TerminalHostHandle>(null);
  const known = useTerminalsStore((s) => id in s.byId);
  const ran = tab.params.ran ?? "";
  return (
    <div
      className="flex min-h-0 flex-1 flex-col outline-none"
      tabIndex={-1}
      data-focus-root
      data-testid="shell-terminal"
      data-terminal-tab={tab.id}
      onFocus={(e) => {
        if (e.target === e.currentTarget) ref.current?.focus();
      }}
    >
      {ran && (
        <RanLine
          ran={ran}
          onRun={() => runAgain(tab, ran)}
          onDismiss={() => {
            void forgetRan(tab);
          }}
        />
      )}
      <TerminalHost ref={ref} terminalId={id && known ? id : null} testId="shell-terminal-host" />
    </div>
  );
}

/** A terminal tab's name field in its strip (cmd+r, Rename…): Enter or leaving it renames; Escape keeps the name; empty goes back to the automatic name. */
export function TabNameField({ tab, className }: { tab: TabEntry; className?: string }) {
  const auto = useTerminalTabName({ name: "", params: tab.params }).name;
  const [value, setValue] = useState(tab.name);
  const input = useRef<HTMLInputElement>(null);
  const done = useRef(false);
  useEffect(() => {
    input.current?.focus();
    input.current?.select();
  }, []);
  const finish = (commit: boolean) => {
    if (done.current) return;
    done.current = true;
    endTabRename();
    if (commit && value.trim() !== tab.name) void renameTab(tab.id, value);
  };
  return (
    <input
      ref={input}
      value={value}
      placeholder={auto}
      aria-label="Tab name"
      data-testid="shell-tab-name-field"
      className={cn("h-5 min-w-0 flex-1 rounded-sm border border-cf-focus bg-cf-surface px-1 text-body-sm text-cf-text outline-none", className)}
      onChange={(e) => {
        setValue(e.target.value);
      }}
      // Selecting text in the field is not a drag of its tab (the strip skips the drag too).
      onPointerDown={(e) => {
        e.stopPropagation();
      }}
      onKeyDown={(e) => {
        e.stopPropagation();
        if (e.key === "Enter") finish(true);
        else if (e.key === "Escape") finish(false);
      }}
      onBlur={() => {
        finish(true);
      }}
    />
  );
}

/** A terminal tab's context menu: rename, its automatic name again, close (which ends the terminal). */
export function TerminalTabMenu({ tab }: { tab: TabEntry }) {
  return (
    <>
      <ContextMenuItem
        onSelect={() => {
          renameAfterMenuCloses(tab.id);
        }}
      >
        Rename…
      </ContextMenuItem>
      <ContextMenuItem disabled={!tab.name} onSelect={() => void autoNameTab(tab.id)}>
        Automatic name
      </ContextMenuItem>
      <ContextMenuSeparator />
      <ContextMenuItem onSelect={() => void closeTabNow(tab.id)}>Close terminal</ContextMenuItem>
    </>
  );
}
