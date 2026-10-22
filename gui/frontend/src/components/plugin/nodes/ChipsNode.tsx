import { useRef, type KeyboardEvent } from "react";
import type { Chip } from "@/api/plugin";
import { cn } from "@/lib/utils";
import { useRunAction } from "../actions";
import { useViewCtx } from "../context";
import { InlineView } from "../parts";
import type { NodeProps } from "../registry";
import { statusIcon, statusTone } from "../tones";

function ChipView({ chip, focusable }: { chip: Chip; focusable: boolean }) {
  const run = useRunAction();
  const { inert } = useViewCtx();
  // A chip without a status has no glyph (the empty status would draw as pending).
  const glyph = chip.status ? statusIcon[chip.status] : null;
  const tone = statusTone(chip.status);
  const clickable = chip.action !== undefined && !inert;
  return (
    <button
      type="button"
      tabIndex={focusable ? 0 : -1}
      aria-disabled={!clickable || undefined}
      aria-pressed={chip.selected ?? false}
      className={cn(
        "flex h-6 min-w-0 shrink-0 items-center gap-1.5 rounded-md border px-2 text-body-sm outline-none focus-visible:ring-1 focus-visible:ring-cf-focus",
        tone === "error" ? "border-cf-error/35 text-cf-error-text" : tone === "attention" ? "border-cf-warning/35 text-cf-warning-text" : "border-cf-border",
        clickable && "hover:bg-cf-control-hover dark:hover:bg-cf-control-hover/50",
        chip.selected && "bg-cf-control-hover dark:bg-cf-control-hover/50",
      )}
      data-testid="plugin-chip"
      data-key={chip.key}
      data-status={chip.status || undefined}
      data-selected={chip.selected || undefined}
      onClick={() => {
        if (clickable) run(chip.key, chip.action);
      }}
    >
      {glyph && <glyph.icon className={cn("size-3.5 shrink-0", glyph.className)} aria-hidden />}
      <span className="truncate">{chip.label}</span>
      {chip.meta !== undefined && <InlineView value={chip.meta} className="shrink-0 text-caption-sm tabular-nums" />}
    </button>
  );
}

/** Stages or steps with status and duration; they wrap, never scroll. Arrow keys move between chips. */
export function ChipsNode({ data }: NodeProps<"chips">) {
  const ref = useRef<HTMLDivElement>(null);
  const selected = data.chips.findIndex((c) => c.selected);
  const onKey = (e: KeyboardEvent<HTMLDivElement>) => {
    const step = e.key === "ArrowRight" ? 1 : e.key === "ArrowLeft" ? -1 : 0;
    if (!step || !ref.current) return;
    const chips = Array.from(ref.current.querySelectorAll<HTMLButtonElement>("button"));
    const i = chips.findIndex((c) => c === document.activeElement);
    if (i < 0) return;
    e.preventDefault();
    chips[(i + step + chips.length) % chips.length]?.focus();
  };
  return (
    <div ref={ref} role="group" className="flex min-w-0 flex-wrap gap-1.5" data-testid="plugin-chips" onKeyDown={onKey}>
      {data.chips.map((c, i) => (
        <ChipView key={c.key} chip={c} focusable={i === (selected < 0 ? 0 : selected)} />
      ))}
    </div>
  );
}
