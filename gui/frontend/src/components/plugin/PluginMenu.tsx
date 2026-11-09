/**
 * A plugin's menus (docs/notes/plugin-menu.md) drawn with the app's own Radix menus and
 * their look (the Projects page's ⋯ and right-click menus): a ⋯ dropdown (a row's, the
 * header's), a row's right-click menu, and a menu button's dropdown. Text items, a
 * one-level submenu, one-pick groups (a check at the picked one), separators; danger
 * items in the destructive red, disabled ones inert. A picked item runs its action once
 * the menu has closed and given focus back (to the ⋯, the button, or the row), through
 * the same path as a button (useRunAction).
 */
import { useRef, type ReactNode } from "react";
import { Ellipsis, LoaderCircle } from "lucide-react";
import type { ComponentType } from "react";
import type { ViewMenuItem } from "@/api/plugin";
import { ContextMenu, ContextMenuContent, ContextMenuItem, ContextMenuRadioGroup, ContextMenuRadioItem, ContextMenuSeparator, ContextMenuSub, ContextMenuSubContent, ContextMenuSubTrigger, ContextMenuTrigger } from "@/components/ui/context-menu";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuSeparator,
  DropdownMenuSub,
  DropdownMenuSubContent,
  DropdownMenuSubTrigger,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Tip } from "@/components/ui/tooltip";
import { cn } from "@/lib/utils";
import { useRunAction } from "./actions";
import { useViewCtx } from "./context";
import { menuBlocks, type MenuBlock } from "./menu";
import { useMenuPending } from "./menuPending";

type Tagged = { children?: ReactNode; "data-testid"?: string; "data-key"?: string; className?: string };

/** The parts a menu draws with: a dropdown's or a context menu's (their props differ; the blocks need only these). */
interface MenuKit {
  Item: ComponentType<Tagged & { variant?: "default" | "destructive"; disabled?: boolean; onSelect?: (e: Event) => void }>;
  Separator: ComponentType;
  Sub: ComponentType<{ children?: ReactNode }>;
  SubTrigger: ComponentType<Tagged & { disabled?: boolean }>;
  SubContent: ComponentType<Tagged>;
  RadioGroup: ComponentType<{ value?: string; children?: ReactNode }>;
  RadioItem: ComponentType<Tagged & { value: string; disabled?: boolean; onSelect?: (e: Event) => void; "data-checked"?: string }>;
}

const DROPDOWN: MenuKit = {
  Item: DropdownMenuItem,
  Separator: DropdownMenuSeparator,
  Sub: DropdownMenuSub,
  SubTrigger: DropdownMenuSubTrigger,
  SubContent: DropdownMenuSubContent,
  RadioGroup: DropdownMenuRadioGroup,
  RadioItem: DropdownMenuRadioItem,
};

const CONTEXT: MenuKit = {
  Item: ContextMenuItem,
  Separator: ContextMenuSeparator,
  Sub: ContextMenuSub,
  SubTrigger: ContextMenuSubTrigger,
  SubContent: ContextMenuSubContent,
  RadioGroup: ContextMenuRadioGroup,
  RadioItem: ContextMenuRadioItem,
};

/** The menu's width: the app's 200 px menus, at most 320 px (a longer label truncates, whole in its tooltip). */
const CONTENT = "max-w-80 min-w-[200px]";

/** An item's label: one line, its whole text in a tooltip when cut. */
function Label({ text }: { text: string }) {
  return (
    <Tip label={text} whenTruncated>
      <span className="min-w-0 truncate">{text}</span>
    </Tip>
  );
}

/** A menu's blocks with `kit`; each item records itself with `onPick`. */
function Blocks({ blocks, kit, onPick, inert }: { blocks: readonly MenuBlock[]; kit: MenuKit; onPick: (it: ViewMenuItem & { key: string }) => void; inert: boolean }) {
  return blocks.map((b) => {
    switch (b.kind) {
      case "separator":
        return <kit.Separator key={`sep-${String(b.at)}`} />;
      case "item":
        return (
          <kit.Item
            key={b.item.key}
            variant={b.item.danger ? "destructive" : "default"}
            disabled={(b.item.disabled ?? false) || inert}
            data-testid="plugin-menu-item"
            data-key={b.item.key}
            onSelect={() => {
              onPick(b.item);
            }}
          >
            <Label text={b.item.label ?? ""} />
          </kit.Item>
        );
      case "sub":
        return (
          <kit.Sub key={b.item.key}>
            <kit.SubTrigger disabled={(b.item.disabled ?? false) || inert} data-testid="plugin-menu-sub" data-key={b.item.key}>
              <Label text={b.item.label ?? ""} />
            </kit.SubTrigger>
            <kit.SubContent className={CONTENT} data-testid="plugin-menu-submenu" data-key={b.item.key}>
              <Blocks blocks={b.blocks} kit={kit} onPick={onPick} inert={inert} />
            </kit.SubContent>
          </kit.Sub>
        );
      case "group":
        return (
          <kit.RadioGroup key={`group-${b.group}-${b.items[0]?.key ?? ""}`} value={b.value}>
            {b.items.map((it) => (
              <kit.RadioItem
                key={it.key}
                value={it.key}
                disabled={(it.disabled ?? false) || inert}
                className={cn(it.danger && "text-cf-error-text")}
                data-testid="plugin-menu-item"
                data-key={it.key}
                data-checked={it.key === b.value ? "" : undefined}
                onSelect={() => {
                  onPick(it);
                }}
              >
                <Label text={it.label ?? ""} />
              </kit.RadioItem>
            ))}
          </kit.RadioGroup>
        );
    }
    return null;
  });
}

/**
 * What a menu's pick does: records the item (`pick`), and once the menu has closed runs its
 * action with the item's key (`flush`, from onCloseAutoFocus), as the Projects page's menus
 * do, so a dialog the action opens (a command's confirm) keeps its focus.
 */
function usePicked(): { pick: (it: ViewMenuItem & { key: string }) => void; flush: () => void } {
  const run = useRunAction();
  const picked = useRef<(ViewMenuItem & { key: string }) | null>(null);
  return {
    pick: (it) => {
      picked.current = it;
    },
    flush: () => {
      const it = picked.current;
      picked.current = null;
      if (it) run(it.key, it.action);
    },
  };
}

/** Portal events still bubble through React: a menu's keys and clicks stay out of the row it belongs to. */
const stop = (e: { stopPropagation: () => void }) => {
  e.stopPropagation();
};

/**
 * The ⋯ "More options" button and its dropdown: a row's (`className` shows it on hover and
 * focus), the header's. Enter, Space and the arrow keys open it (Radix); Escape closes it
 * and focus comes back to it.
 */
export function MoreMenu({ items, label = "More options", testId = "plugin-more", className }: { items: readonly ViewMenuItem[]; label?: string; testId?: string; className?: string }) {
  const { inert } = useViewCtx();
  const { pick, flush } = usePicked();
  const busy = useMenuPending(items);
  return (
    <DropdownMenu modal={false}>
      <Tip label={label}>
        <DropdownMenuTrigger asChild>
          <button
            type="button"
            aria-label={label}
            disabled={inert}
            data-testid={testId}
            className={cn(
              "flex size-6 shrink-0 items-center justify-center rounded-md text-cf-text-muted outline-none hover:bg-cf-control-hover hover:text-cf-text focus-visible:ring-1 focus-visible:ring-cf-focus disabled:pointer-events-none disabled:opacity-50 aria-expanded:bg-cf-control-hover aria-expanded:text-cf-text [&_svg]:size-3.5",
              className,
            )}
            onClick={stop}
          >
            {busy ? <LoaderCircle className="animate-spin motion-reduce:animate-none" aria-hidden /> : <Ellipsis aria-hidden />}
          </button>
        </DropdownMenuTrigger>
      </Tip>
      <DropdownMenuContent align="end" className={CONTENT} data-testid={`${testId}-menu`} onKeyDown={stop} onClick={stop} onCloseAutoFocus={flush}>
        <Blocks blocks={menuBlocks(items)} kit={DROPDOWN} onPick={pick} inert={inert} />
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

/**
 * A menu button's dropdown (a "Rebuild ▾"): `children` is the button (with its tooltip),
 * made the trigger by a DropdownMenuTrigger; the menu opens under it, at its start.
 */
export function MenuButtonMenu({ items, testId, children }: { items: readonly ViewMenuItem[]; testId: string; children: ReactNode }) {
  const { inert } = useViewCtx();
  const { pick, flush } = usePicked();
  return (
    <DropdownMenu modal={false}>
      {children}
      <DropdownMenuContent align="start" className={CONTENT} data-testid={`${testId}-menu`} onKeyDown={stop} onClick={stop} onCloseAutoFocus={flush}>
        <Blocks blocks={menuBlocks(items)} kit={DROPDOWN} onPick={pick} inert={inert} />
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

/**
 * A row's right-click menu: `children` (the row's element, which takes a ref and handlers)
 * is the trigger, and the menu opens at the pointer. The ContextMenu key and Shift+F10 on
 * the focused row (or a control in it) open it at the row's start, as a right-click there
 * would. Closing gives focus back to what had it (the row, or the ⋯ it was opened from).
 */
export function RowContextMenu({ items, children }: { items: readonly ViewMenuItem[] | null; children: ReactNode }) {
  const { inert } = useViewCtx();
  const { pick, flush } = usePicked();
  if (!items) return children;
  return (
    <ContextMenu modal={false}>
      <ContextMenuTrigger asChild disabled={inert}>
        {children}
      </ContextMenuTrigger>
      <ContextMenuContent className={CONTENT} data-testid="plugin-row-menu" onKeyDown={stop} onClick={stop} onCloseAutoFocus={flush}>
        <Blocks blocks={menuBlocks(items)} kit={CONTEXT} onPick={pick} inert={inert} />
      </ContextMenuContent>
    </ContextMenu>
  );
}
