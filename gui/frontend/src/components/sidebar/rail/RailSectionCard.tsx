import { useCallback, useRef, useState, type KeyboardEvent } from "react";
import type { LucideIcon } from "lucide-react";
import { HoverCard, HoverCardContent, HoverCardTrigger } from "@/components/ui/hover-card";
import type { ShellRow } from "@/lib/shellSections";
import type { FooterSection, HeaderRow } from "@/lib/tree";
import { cn } from "@/lib/utils";
import { useShellDragStore } from "@/shell/drag/state";
import { rowGap } from "../rowSizes";
import { PanelRows, type ScrollTo } from "../shell/ShellSidebarList";
import { ThreadListbox } from "../shell/ThreadListbox";
import { RAIL_CARD_MAX, railTileClass } from "./railLook";

/**
 * Working, Snoozed or Archived on the rail (docs/notes/sidebar-rail.md): one icon, and hovering
 * or focusing it opens a card beside the rail listing the section's rows as the expanded sidebar
 * draws them, "a menu inside a hover card". The rows are the expanded footer's (PanelRows over the
 * row views) inside the sidebar's listbox (ThreadListbox), so a row clicks, right-clicks, drags
 * and shows its own hover card as it does there. The card lists every row whatever the section's
 * collapsed state in the expanded sidebar, and never changes that state.
 */

/** The card's open and close delay: the pointer crosses the gap from the icon into it within it. */
const CARD_DELAY = 200;

function hovered(el: Element | null): boolean {
  return el?.matches(":hover") ?? false;
}

/**
 * Whether the keyboard is in the card: focus there that the keyboard put there (:focus-visible).
 * A right click focuses the list too, but only the pointer keeps the card open then.
 */
function keyboardIn(content: Element | null): boolean {
  const el = document.activeElement;
  return el !== null && (content?.contains(el) ?? false) && el.matches(":focus-visible");
}

interface RailSectionCardProps {
  section: FooterSection;
  /** The section's header in the expanded list: its name and count. */
  header: HeaderRow;
  /** Its rows, every one (useShellListRows expandAll). */
  rows: readonly ShellRow[];
  icon: LucideIcon;
  tone: string;
}

export function RailSectionCard({ section, header, rows, icon: Icon, tone }: RailSectionCardProps) {
  const [hover, setHover] = useState(false);
  const [menu, setMenu] = useState(false);
  const [focused, setFocused] = useState(false);
  const [dragHeld, setDragHeld] = useState(false);
  const trigger = useRef<HTMLButtonElement>(null);
  const content = useRef<HTMLDivElement>(null);
  const scrollTo = useRef<ScrollTo>(null);
  const shown = hover || menu || focused;
  // A row dragged out of the card: the card stays mounted (it is the drag's source) but out of
  // sight until the drop, then closes.
  const dragging = useShellDragStore((s) => s.source !== null);
  if (dragging && shown && !dragHeld) setDragHeld(true);
  if (!dragging && dragHeld) {
    setDragHeld(false);
    setHover(false);
    setFocused(false);
  }
  const open = shown || dragHeld;

  /** Open only while the pointer is over the icon or the card, or the keyboard is in it. */
  const settle = useCallback(() => {
    setHover(hovered(trigger.current) || hovered(content.current));
    setFocused(keyboardIn(content.current));
  }, []);
  const close = () => {
    setHover(false);
    setMenu(false);
    setFocused(false);
  };
  const focusList = () => {
    const list = content.current?.querySelector<HTMLElement>('[role="listbox"]');
    list?.focus();
  };
  const onTriggerKey = (e: KeyboardEvent) => {
    if (e.key !== "ArrowRight" && e.key !== "ArrowDown" && e.key !== "Enter" && e.key !== " ") return;
    e.preventDefault();
    if (!open) setHover(true);
    // The list mounts with the card: give it the keyboard once it is there.
    requestAnimationFrame(focusList);
  };

  const label = `${header.label} · ${String(header.count)}`;
  return (
    <HoverCard
      open={open}
      onOpenChange={(o) => {
        // Radix closes on the pointer leaving or the icon's blur; a row's menu or the keyboard in the card keeps it.
        setHover(o);
      }}
      openDelay={CARD_DELAY}
      closeDelay={CARD_DELAY}
    >
      <HoverCardTrigger asChild>
        <button
          ref={trigger}
          type="button"
          aria-label={label}
          aria-haspopup="listbox"
          aria-expanded={open}
          className={cn(railTileClass(false, false), open && !dragHeld && "bg-cf-sidebar-row-hover", "focus-visible:ring-1 focus-visible:ring-cf-focus focus-visible:ring-inset")}
          data-testid={`rail-${section}`}
          data-count={header.count}
          onKeyDown={onTriggerKey}
        >
          <Icon className={cn("size-4 shrink-0", tone)} aria-hidden />
        </button>
      </HoverCardTrigger>
      <HoverCardContent
        ref={content}
        side="right"
        align="start"
        // The header's line sits level with the icon.
        alignOffset={-4}
        className={cn("w-[248px] p-1", dragHeld && "pointer-events-none opacity-0")}
        data-testid={`rail-${section}-card`}
        onFocus={() => {
          setFocused(keyboardIn(content.current));
        }}
        onBlur={(e) => {
          if (e.relatedTarget instanceof Node && e.currentTarget.contains(e.relatedTarget)) return;
          setFocused(false);
        }}
        // Escape shuts it (the list's own Escape then hands the keyboard to the open thread's prompt).
        onEscapeKeyDown={close}
      >
        <div className="flex items-center justify-between px-2 pt-1 pb-1.5 text-caption text-cf-sidebar-muted-foreground" data-testid="rail-card-header">
          <span data-testid="rail-card-label">{header.label}</span>
          <span className="tabular-nums" data-testid="rail-card-count">
            {header.count}
          </span>
        </div>
        <ThreadListbox
          rows={rows}
          scrollToRow={(row) => {
            scrollTo.current?.(rows.indexOf(row));
          }}
          testId={`rail-${section}-list`}
          label={header.label}
          claimsFocus={false}
          onMenuOpenChange={(o) => {
            setMenu(o);
            if (!o) settle();
          }}
        >
          {({ selectedKey, cursorKey, activate }) => (
            <PanelRows
              rows={rows}
              selectedKey={selectedKey}
              cursorKey={cursorKey}
              onActivate={(row) => {
                activate(row);
                close();
              }}
              scrollTo={scrollTo}
              maxHeight={RAIL_CARD_MAX}
              gap={rowGap(section)}
              paddingStart={0}
              paddingEnd={0}
              fade
              testId={`rail-${section}-rows`}
            />
          )}
        </ThreadListbox>
      </HoverCardContent>
    </HoverCard>
  );
}
