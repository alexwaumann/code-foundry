import { useRef, useState, type ComponentType, type ReactNode } from "react";
import { Ellipsis, Loader2 } from "lucide-react";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuSeparator, DropdownMenuTrigger } from "@/components/ui/dropdown-menu";
import { Tip } from "@/components/ui/tooltip";
import { cn } from "@/lib/utils";
import { dismissFrom, RowMenuPickContext, type RowMenuEntry, type RowMenuPart, type RowMenuParts, type RowMenuPick } from "./rowMenu";

/**
 * One item of a Projects page menu (a header's or row's ⋯, a row's context menu); "separator" draws a line.
 * Text only: menus have no icons and no trailing "…" (docs/notes/projects-table-2-context-menus.md).
 */
export type OverflowItem =
  | {
      label: string;
      onSelect: () => void;
      destructive?: boolean;
      testId: string;
      /** Shown at the item's right, e.g. how many things it acts on. */
      badge?: number;
      /** A second, quieter line under the label: what the item stands on ("Read 5 min ago"), or why it is disabled. */
      hint?: string;
      disabled?: boolean;
    }
  | "separator";

/** The item and separator parts of a dropdown or a context menu (their props differ; the items need only these). */
export interface MenuParts {
  Item: ComponentType<{ variant?: "default" | "destructive"; disabled?: boolean; onSelect?: (e: Event) => void; "data-testid"?: string; children?: ReactNode }>;
  Separator: ComponentType;
}

/** The items of a menu: each records its action in `onPick` (run once the menu has closed); the badge at the right. */
export function MenuItems({ items, parts: { Item, Separator }, onPick }: { items: readonly OverflowItem[]; parts: MenuParts; onPick: (run: () => void) => void }) {
  return items.map((it, i) =>
    it === "separator" ? (
      <Separator key={`sep-${String(i)}`} />
    ) : (
      <Item
        key={it.testId}
        variant={it.destructive ? "destructive" : "default"}
        data-testid={it.testId}
        disabled={it.disabled}
        onSelect={() => {
          onPick(it.onSelect);
        }}
      >
        {it.hint ? (
          <span className="flex min-w-0 flex-col">
            <span>{it.label}</span>
            <span className="text-caption-sm" data-testid={`${it.testId}-hint`}>
              {it.hint}
            </span>
          </span>
        ) : (
          it.label
        )}
        {it.badge !== undefined && (
          <span className="ml-auto pl-4 text-caption tabular-nums" data-testid={`${it.testId}-count`}>
            {it.badge}
          </span>
        )}
      </Item>
    ),
  );
}

/**
 * A menu's entries (rowMenu.ts RowMenuEntry): runs of text items go to MenuItems, an entry
 * with a `kind` (a submenu, a split item) to the part registered for it in `parts`.
 */
export function MenuEntries<P extends RowMenuPart>({ entries, parts, menu, onPick }: { entries: readonly RowMenuEntry<P>[]; parts: RowMenuParts<P>; menu: MenuParts; onPick: (run: () => void) => void }) {
  let run: OverflowItem[] = [];
  const out: React.ReactNode[] = [];
  const flush = () => {
    if (run.length > 0) out.push(<MenuItems key={`items-${String(out.length)}`} items={run} parts={menu} onPick={onPick} />);
    run = [];
  };
  for (const e of entries) {
    if (e === "separator" || !("kind" in e)) {
      run.push(e);
      continue;
    }
    flush();
    // Each kind's part takes that kind's entry (RowMenuParts); looked up by the entry's own kind.
    const Part = (parts as unknown as Readonly<Partial<Record<string, ComponentType<{ entry: P }>>>>)[e.kind];
    if (Part) out.push(<Part key={e.testId} entry={e} />);
  }
  flush();
  return out;
}

const DROPDOWN_PARTS: MenuParts = { Item: DropdownMenuItem, Separator: DropdownMenuSeparator };
const NO_PARTS = {};

/**
 * The "More" (…) action of a Projects page row or header: a dropdown of the row's less
 * frequent and destructive actions. The trigger is a row action (mouse; the palette
 * reaches the same commands by keyboard). Keys inside the menu stay in it (the list's
 * arrow keys must not move its cursor meanwhile). Closing it gives the keyboard back to
 * the page's list, and only then runs the picked item: a menu still animating out takes
 * the focus back when the pointer leaves its items, which would pull it out of a dialog
 * or the palette the item opened (and their focus scopes select the input on return, so
 * the next keystroke replaced what was typed). Entries with a `kind` (a split item) are drawn
 * by `parts`, as in a row's right-click menu (RowContextMenu.tsx).
 */
export function OverflowMenu<P extends RowMenuPart = never>({
  label,
  items,
  parts,
  testId,
  size = "sm",
  tabbable = false,
  busy = false,
  triggerClassName,
}: {
  label: string;
  items: readonly RowMenuEntry<P>[];
  parts?: RowMenuParts<P>;
  testId: string;
  /** "md": a page title block's (28px, a 16px glyph); "sm": a row's. */
  size?: "sm" | "md";
  /** In the tab order: for a page with no list cursor to reach the row's actions (Settings), where the palette has no twin of every item. */
  tabbable?: boolean;
  /** Something the menu started is running: the trigger spins. */
  busy?: boolean;
  triggerClassName?: string;
}) {
  const triggerRef = useRef<HTMLButtonElement>(null);
  const picked = useRef<(() => void) | null>(null);
  const [pick] = useState<RowMenuPick>(() => ({
    pick: (run) => {
      picked.current = run;
    },
    close: (run, from) => {
      picked.current = run;
      dismissFrom(from);
    },
  }));
  return (
    <DropdownMenu modal={false}>
      <Tip label={label}>
        <DropdownMenuTrigger asChild>
          <button
            ref={triggerRef}
            type="button"
            tabIndex={tabbable ? 0 : -1}
            aria-label={label}
            data-testid={testId}
            className={cn(
              "flex shrink-0 items-center justify-center rounded-md text-cf-text-muted hover:bg-cf-control-hover hover:text-cf-text aria-expanded:bg-cf-control-hover aria-expanded:text-cf-text",
              size === "md" ? "size-7 [&_svg]:size-4" : "size-6 [&_svg]:size-3.5",
              tabbable && "outline-none focus-visible:ring-1 focus-visible:ring-cf-focus",
              triggerClassName,
            )}
            onClick={(e) => {
              e.stopPropagation();
            }}
            onDoubleClick={(e) => {
              e.stopPropagation();
            }}
          >
            {busy ? <Loader2 className="animate-spin" aria-hidden /> : <Ellipsis />}
          </button>
        </DropdownMenuTrigger>
      </Tip>
      <DropdownMenuContent
        align="end"
        className="min-w-[200px]"
        data-testid={`${testId}-menu`}
        onKeyDown={(e) => {
          e.stopPropagation();
        }}
        onClick={(e) => {
          // Portal events still bubble through React: not to the row (cursor, activation).
          e.stopPropagation();
        }}
        onDoubleClick={(e) => {
          e.stopPropagation();
        }}
        onCloseAutoFocus={(e) => {
          e.preventDefault();
          const active = document.activeElement;
          if (!active || active === document.body || active === triggerRef.current) {
            triggerRef.current?.closest<HTMLElement>("[data-focus-root]")?.focus({ preventScroll: true });
          }
          const run = picked.current;
          picked.current = null;
          run?.();
        }}
      >
        <RowMenuPickContext.Provider value={pick}>
          <MenuEntries entries={items} parts={parts ?? (NO_PARTS as RowMenuParts<P>)} menu={DROPDOWN_PARTS} onPick={pick.pick} />
        </RowMenuPickContext.Provider>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
