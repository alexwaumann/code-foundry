import { useRef, useState } from "react";
import { ArrowUp } from "lucide-react";
import { QuoteGlyph } from "@/components/compose/QuoteGlyph";
import { TAG_ACCENT, tagClass } from "@/components/compose/tagStyle";
import { Button } from "@/components/ui/button";
import { Popover, PopoverAnchor, PopoverContent } from "@/components/ui/popover";
import { citeLabel, type CitationBody } from "@/lib/citation";
import { cn } from "@/lib/utils";
import { requestFlash } from "@/stores/cite";
import { useThreadStore } from "@/stores/thread";
import { useThreadCtx } from "../context";

function timeOf(ms: number | null | undefined): string {
  return ms
    ? new Date(ms).toLocaleTimeString([], {
        hour: "2-digit",
        minute: "2-digit",
      })
    : "";
}

/**
 * A citation in a sent message's bubble (docs/notes/citations.md), drawn as the composer's
 * chip. A click opens a popover hanging under the whole bubble, its left edge at the chip
 * (so it never covers the rest of the message): the quote muted behind a rule (four lines,
 * then it scrolls), the comment, "Claude · 14:02" (the quoted answer's time) and Go to
 * source, which scrolls to the quote and flashes it. When the answer is not in this
 * thread's items (compacted away, a fork without it) Go to source is disabled and the
 * footer says so.
 */
export function CiteChip({ cite }: { cite: CitationBody }) {
  const { threadId } = useThreadCtx();
  const source = useThreadStore((s) => s.logs[threadId]?.byId[cite.itemId]);
  const [open, setOpen] = useState(false);
  const chipRef = useRef<HTMLButtonElement>(null);
  // Under the bubble, at the chip's left edge.
  const anchor = useRef({
    getBoundingClientRect: () => {
      const chip = chipRef.current?.getBoundingClientRect();
      const bubble = chipRef.current?.closest(".bubble")?.getBoundingClientRect();
      return DOMRect.fromRect({
        x: chip?.left ?? 0,
        y: bubble?.bottom ?? chip?.bottom ?? 0,
        width: 0,
        height: 0,
      });
    },
  });
  const present = source !== undefined;
  const time = timeOf(source?.createdAtMs);
  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverAnchor virtualRef={anchor} />
      <button
        ref={chipRef}
        type="button"
        data-testid="thread-tag"
        data-tag-kind="cite"
        data-item={cite.itemId}
        data-state={open ? "open" : "closed"}
        aria-haspopup="dialog"
        aria-expanded={open}
        aria-label={`Quote: ${cite.text}`}
        onClick={() => {
          setOpen((o) => !o);
        }}
        className={tagClass(
          false,
          cn(
            TAG_ACCENT.cite,
            "cursor-pointer data-[state=open]:border-[color-mix(in_oklab,var(--chip-accent)_48%,var(--cf-border))] data-[state=open]:bg-[color-mix(in_oklab,var(--chip-accent)_17%,transparent)]",
          ),
        )}
      >
        <QuoteGlyph />
        <span className="truncate">{citeLabel(cite.text)}</span>
      </button>
      <PopoverContent
        side="bottom"
        align="start"
        sideOffset={6}
        collisionPadding={12}
        updatePositionStrategy="always"
        className="w-80 p-3 whitespace-normal"
        data-testid="cite-source"
        onInteractOutside={(e) => {
          // The chip toggles it itself.
          if (e.target instanceof Node && chipRef.current?.contains(e.target)) e.preventDefault();
        }}
      >
        <div
          className="max-h-[72px] overflow-y-auto border-l-2 border-[color-mix(in_oklab,var(--cf-text)_22%,transparent)] py-px pl-2.5 text-body-sm whitespace-pre-wrap text-cf-text-muted"
          data-testid="cite-source-quote"
        >
          {cite.text}
        </div>
        {cite.comment && (
          <p className="mt-2.5 text-body-sm whitespace-pre-wrap" data-testid="cite-source-comment">
            {cite.comment}
          </p>
        )}
        <div className="mt-3 flex items-center gap-2 border-t pt-2.5">
          <span className="text-caption-sm text-cf-text-muted" data-testid="cite-source-meta">
            {present ? ["Claude", time].filter(Boolean).join(" · ") : "No longer in this thread"}
          </span>
          <Button
            type="button"
            variant="outline"
            size="xs"
            className="ml-auto"
            disabled={!present}
            data-testid="cite-go-to-source"
            onClick={() => {
              setOpen(false);
              requestFlash(threadId, cite);
            }}
          >
            <ArrowUp aria-hidden />
            Go to source
          </Button>
        </div>
      </PopoverContent>
    </Popover>
  );
}
