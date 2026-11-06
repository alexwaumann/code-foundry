import type { ReactNode } from "react";
import { Loader2 } from "lucide-react";
import { VirtualStack } from "@/components/pr/VirtualStack";
import { cn } from "@/lib/utils";
import { countWords } from "./model";

/** A group's header: its name, how many, a note ("showing the first 200"), and what acts on the group at the right. */
export function GroupHeader({
  id,
  label,
  count,
  note,
  busy = false,
  first,
  children,
}: {
  id: string;
  label: string;
  count: number | null;
  note?: string;
  busy?: boolean;
  first: boolean;
  children?: ReactNode;
}) {
  return (
    <div
      className={cn("flex min-h-7.5 min-w-0 items-center gap-2 bg-cf-surface-sunken px-3 py-1 text-caption-sm font-medium", !first && "border-t border-cf-border")}
      data-testid="catalog-group"
      data-group={id}
      role={busy ? "status" : undefined}
    >
      <span className="shrink-0">{label}</span>
      {count !== null && (
        <span className="shrink-0 tabular-nums" data-testid="catalog-group-count">
          {countWords(count)}
        </span>
      )}
      {note && (
        <span className="min-w-0 truncate font-normal" data-testid="catalog-group-note">
          {note}
        </span>
      )}
      {busy && <Loader2 className="size-3 shrink-0 animate-spin" aria-hidden />}
      {children && <span className="ml-auto flex shrink-0 items-center gap-1.5">{children}</span>}
    </div>
  );
}

/** A line in the card: nothing to list, or why. */
export function CatalogLine({ first, testId, children }: { first: boolean; testId: string; children: ReactNode }) {
  return (
    <p className={cn("px-3 py-3 text-caption", !first && "border-t border-cf-border")} data-testid={testId}>
      {children}
    </p>
  );
}

/** A failure or warning at the top of the card, in words. */
export function CatalogNotice({ tone, testId, children }: { tone: "error" | "warning"; testId: string; children: ReactNode }) {
  return (
    <p className={cn("border-b border-cf-border px-3 py-2.5 text-caption break-words", tone === "error" ? "text-cf-error-text" : "text-cf-warning-text")} role="alert" data-testid={testId}>
      {children}
    </p>
  );
}

/**
 * The card both pages list in: notices, then groups and rows as one flat list, virtualised
 * on the page's own scroll box past VirtualStack's threshold (a row's expansion is measured
 * in place). data-section is where the settings search's Installed hit lands.
 */
export function CatalogCard<T>({
  notices,
  items,
  itemKey,
  render,
  testId,
}: {
  notices?: ReactNode;
  items: readonly T[];
  itemKey: (item: T) => string;
  render: (item: T, index: number) => ReactNode;
  testId: string;
}) {
  return (
    <div className="mt-3 overflow-hidden rounded-lg border border-cf-border" data-testid={testId} data-section="installed">
      {notices}
      <VirtualStack items={items} itemKey={itemKey} estimate={38} testId={`${testId}-rows`} render={render} />
    </div>
  );
}
