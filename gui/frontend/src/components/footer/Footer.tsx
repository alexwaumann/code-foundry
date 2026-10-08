import { useMemo } from "react";
import { hintsFor } from "@/keys/hints";
import { useCommandsStore } from "@/stores/commands";
import { useUiStore } from "@/stores/ui";
import { DaemonStatus } from "./DaemonStatus";

function Hints() {
  const focus = useUiStore((s) => (s.palette.open ? "palette" : s.focus));
  const selection = useUiStore((s) => s.selection);
  const commands = useCommandsStore((s) => s.commands);
  const hints = useMemo(() => hintsFor(focus, selection, commands), [focus, selection, commands]);
  return (
    <ul className="flex min-w-0 items-center gap-3 overflow-hidden" data-testid="hints" data-focus={focus}>
      {hints.map((h) => (
        <li key={`${h.keys}:${h.label}`} className="flex shrink-0 items-center gap-1">
          <kbd className="rounded border border-border bg-muted/60 px-1 font-sans text-[10px] text-foreground/80">{h.keys}</kbd>
          <span>{h.label}</span>
        </li>
      ))}
    </ul>
  );
}

export function Footer() {
  return (
    <footer className="flex h-7 shrink-0 items-center justify-between gap-4 border-t bg-sidebar px-3 text-[11px] text-muted-foreground">
      <Hints />
      <DaemonStatus />
    </footer>
  );
}
