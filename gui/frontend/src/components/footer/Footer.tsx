import { useMemo } from "react";
import { hintsFor } from "@/keys/hints";
import { useCommandsStore } from "@/stores/commands";
import { useAttentionCount } from "@/stores/sessions";
import { useUiStore } from "@/stores/ui";
import { UpdateIndicator } from "@/components/update/UpdateIndicator";
import { DaemonStatus } from "./DaemonStatus";

function Hints() {
  const focus = useUiStore((s) => (s.palette.open ? "palette" : s.focus));
  const selection = useUiStore((s) => s.selection);
  const commands = useCommandsStore((s) => s.commands);
  const attention = useAttentionCount();
  const hints = useMemo(() => hintsFor(focus, selection, commands, 4, attention), [focus, selection, commands, attention]);
  return (
    // Hints that don't fit wrap onto a hidden second line instead of being cut mid-word.
    <ul className="flex h-7 min-w-0 flex-wrap content-start items-center gap-x-3 overflow-hidden" data-testid="hints" data-focus={focus}>
      {hints.map((h) => (
        <li key={`${h.keys}:${h.label}`} className="flex h-7 shrink-0 items-center gap-1">
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
      <div className="flex min-w-0 shrink-0 items-center gap-3">
        <UpdateIndicator />
        <DaemonStatus />
      </div>
    </footer>
  );
}
