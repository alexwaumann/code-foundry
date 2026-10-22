import { useLayoutEffect, useMemo, useRef, useState } from "react";
import { ArrowDown } from "lucide-react";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import { logLines } from "../log";
import { CopyIconButton } from "../parts";
import type { NodeProps } from "../registry";
import { toneText } from "../tones";

/** One log row's height in px (text-caption-sm's line height). */
const LINE_PX = 16;
/** The box's padding and border in px. */
const BOX_PAD = 14;
/** The fewest lines a log shrinks to in a short pane. */
const MIN_ROWS = 4;

/**
 * A monospace tail the plugin streams (view/append): per-line tone, wrapped with a hanging
 * indent or scrolling sideways inside its box, `rows` lines tall. It follows the end while
 * the user is at the bottom; scrolling up stops that and shows "Jump to end". Copy copies
 * the whole buffer; selection survives appends. Alone in a sized pane shorter than that
 * (PaneNode), it shrinks to the pane, down to MIN_ROWS lines, rather than the pane
 * scrolling and hiding its newest lines; anywhere else nothing around it is that short.
 */
export function LogNode({ data }: NodeProps<"log">) {
  const lines = useMemo(() => logLines(data), [data]);
  const rows = Math.min(40, Math.max(4, data.rows ?? 16));
  const box = useRef<HTMLDivElement>(null);
  // Whether the box sits at its end, so new lines keep it there.
  const [atEnd, setAtEnd] = useState(true);
  const follow = !(data.noFollow ?? false);
  useLayoutEffect(() => {
    const el = box.current;
    if (el && follow && atEnd) el.scrollTop = el.scrollHeight;
  }, [lines, follow, atEnd]);
  const text = useMemo(() => lines.map((l) => l.text).join("\n"), [lines]);
  return (
    <div className="flex min-h-0 min-w-0 flex-col gap-1" data-testid="plugin-log">
      {(data.title || lines.length > 0) && (
        <div className="flex min-w-0 items-center gap-2">
          <span className="min-w-0 flex-1 truncate text-caption-sm">{data.title}</span>
          {lines.length > 0 && <CopyIconButton text={text} label="Copy log" />}
        </div>
      )}
      <div className="relative flex min-h-0 min-w-0 flex-col">
        <div
          ref={box}
          className={cn(
            "min-h-0 overflow-auto rounded-md border border-cf-border bg-cf-surface-sunken/40 px-2 py-1.5 font-mono text-caption-sm text-cf-text select-text [font-variant-ligatures:none]",
            !data.wrap && "whitespace-pre",
          )}
          style={{ height: rows * LINE_PX + BOX_PAD, minHeight: Math.min(rows, MIN_ROWS) * LINE_PX + BOX_PAD }}
          data-testid="plugin-log-box"
          data-lines={lines.length}
          onScroll={(e) => {
            const el = e.currentTarget;
            setAtEnd(el.scrollHeight - el.scrollTop - el.clientHeight < LINE_PX);
          }}
        >
          {data.truncated && <div className="text-cf-text-muted italic">earlier output not shown</div>}
          {lines.map((l, i) => (
            <div key={i} className={cn(data.wrap && "pl-[2ch] -indent-[2ch] break-words whitespace-pre-wrap", toneText[l.tone ?? ""])} data-tone={l.tone || undefined}>
              {l.text || " "}
            </div>
          ))}
        </div>
        {follow && !atEnd && (
          <Button
            variant="outline"
            size="xs"
            className="absolute right-2 bottom-2 bg-cf-surface text-cf-text-muted shadow-xs dark:bg-cf-surface"
            onClick={() => {
              const el = box.current;
              if (el) el.scrollTop = el.scrollHeight;
              setAtEnd(true);
            }}
            data-testid="plugin-log-jump"
          >
            <ArrowDown aria-hidden />
            Jump to end
          </Button>
        )}
      </div>
    </div>
  );
}
