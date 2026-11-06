import type { ReactNode } from "react";
import { ChevronDown, ChevronRight, Loader2, type LucideIcon } from "lucide-react";
import { OverflowMenu, type OverflowItem } from "@/components/projects/OverflowMenu";
import { RowContextMenu } from "@/components/projects/RowContextMenu";
import { Button } from "@/components/ui/button";
import { Switch } from "@/components/ui/switch";
import { Tip } from "@/components/ui/tooltip";
import { cn } from "@/lib/utils";

/** The amber-outlined main action of a row (no filled buttons). */
export const mainAction = "bg-transparent dark:bg-transparent border-cf-warning/40 text-cf-warning-text hover:bg-cf-warning-surface hover:text-cf-warning-text dark:border-cf-warning/40";

/** A row's button: amber for what the row wants done, plain for what it merely offers; the icon spins while it runs. */
export function RowButton({
  icon: Icon,
  busy = false,
  plain = false,
  disabled = false,
  onClick,
  testId,
  children,
}: {
  icon: LucideIcon;
  busy?: boolean;
  plain?: boolean;
  disabled?: boolean;
  onClick: () => void;
  testId: string;
  children: ReactNode;
}) {
  return (
    <Button variant="outline" size="xs" className={cn("shrink-0", plain ? "bg-transparent dark:bg-transparent" : mainAction)} disabled={disabled || busy} onClick={onClick} data-testid={testId}>
      {busy ? <Loader2 className="animate-spin" aria-hidden /> : <Icon aria-hidden />}
      {children}
    </Button>
  );
}

/** What a row is doing that no button of its shows ("Uninstalling…"): the action started from its menu. */
export function RowWorking({ words }: { words: string }) {
  return (
    <span className="flex shrink-0 items-center gap-1 text-caption-sm" role="status" data-testid="catalog-working">
      <Loader2 className="size-3 animate-spin" aria-hidden />
      {words}
    </span>
  );
}

/**
 * A row's enable switch. Flips at once: `checked` is what the command is asking for while it
 * runs (`busy`) and what is true after, so a failure reverts it. `disabled`: the row is doing
 * something else, which a flip would have to wait for.
 */
export function RowSwitch({ checked, busy, disabled, label, onChange, testId }: { checked: boolean; busy: boolean; disabled: boolean; label: string; onChange: (on: boolean) => void; testId: string }) {
  return <Switch checked={checked} disabled={disabled} aria-label={label} aria-busy={busy || undefined} onCheckedChange={onChange} data-testid={testId} data-busy={busy || undefined} />;
}

/**
 * One line of the list: chevron, name, pills, a one-line description, the row's main action,
 * its switch and ⋯ (also its right-click menu). The chevron opens `details` in place; `below`
 * shows whether open or not (a failure). ⋯ means more options, the chevron disclosure.
 */
export function CatalogRow({
  rowKey,
  name,
  pills,
  description,
  action,
  toggle,
  menu,
  open,
  onToggle,
  details,
  below,
  first = false,
  attrs,
}: {
  rowKey: string;
  name: string;
  pills?: ReactNode;
  description: string;
  action?: ReactNode;
  toggle?: ReactNode;
  /** The ⋯ and right-click menu (text only): `testId` names the ⋯, `testId`-context the other. Absent: none. */
  menu?: { label: string; testId: string; items: readonly OverflowItem[] };
  open: boolean;
  onToggle: () => void;
  details: ReactNode;
  below?: ReactNode;
  first?: boolean;
  /** The row's data-* and data-testid. */
  attrs: Readonly<Record<string, string | undefined>>;
}) {
  const Chevron = open ? ChevronDown : ChevronRight;
  const row = (
    <div className={cn("min-w-0", !first && "border-t border-cf-border")} {...attrs}>
      <div className="flex min-h-9.5 min-w-0 items-center gap-2.5 px-3 py-1">
        <button
          type="button"
          className="-mx-1 flex size-5 shrink-0 items-center justify-center rounded-sm text-cf-text-muted outline-none hover:text-cf-text focus-visible:ring-1 focus-visible:ring-cf-focus"
          aria-expanded={open}
          aria-label={`Details of ${name}`}
          onClick={onToggle}
          data-testid="catalog-chevron"
        >
          <Chevron className="size-3" aria-hidden />
        </button>
        <Tip label={name} whenTruncated>
          <span className="max-w-2/5 min-w-0 shrink-0 truncate text-label" data-testid="catalog-name">
            {name}
          </span>
        </Tip>
        {pills}
        <Tip label={description} whenTruncated maxLines={5}>
          <span className="min-w-0 flex-1 truncate text-caption" data-testid="catalog-description">
            {description}
          </span>
        </Tip>
        {action}
        {toggle}
        {menu && <OverflowMenu label={menu.label} items={menu.items} testId={menu.testId} tabbable />}
      </div>
      {below && <div className="min-w-0 pr-3 pb-2 pl-8.5">{below}</div>}
      {open && (
        <div className="flex min-w-0 flex-col gap-1.5 bg-cf-surface-raised pt-2 pr-3 pb-3 pl-8.5" data-testid="catalog-details">
          {details}
        </div>
      )}
    </div>
  );
  if (!menu) return row;
  return (
    <RowContextMenu
      navKey={rowKey}
      testId={`${menu.testId}-context`}
      items={() => menu.items}
    >
      {row}
    </RowContextMenu>
  );
}
