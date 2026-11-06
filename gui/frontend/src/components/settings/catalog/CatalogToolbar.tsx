import type { ReactNode } from "react";
import { Check, Search, X } from "lucide-react";
import { OverflowMenu, type OverflowItem } from "@/components/projects/OverflowMenu";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { cn } from "@/lib/utils";
import { countWords } from "./model";

/** The page's one search field. Escape with text clears it (on an empty one the sheet closes: SettingsSheet). */
function SearchField({ value, placeholder, label, onChange, testId }: { value: string; placeholder: string; label: string; onChange: (text: string) => void; testId: string }) {
  return (
    <div className="relative min-w-48 flex-1">
      <Search className="pointer-events-none absolute top-1/2 left-2 size-3.5 -translate-y-1/2 text-cf-text-muted" aria-hidden />
      <Input
        type="search"
        aria-label={label}
        placeholder={placeholder}
        value={value}
        onChange={(e) => {
          onChange(e.target.value);
        }}
        onKeyDown={(e) => {
          if (e.key === "Escape" && value) onChange("");
        }}
        className="h-7 pr-7 pl-7 text-body-sm [&::-webkit-search-cancel-button]:appearance-none"
        data-testid={testId}
      />
      {value && (
        <Button
          variant="ghost"
          size="icon-xs"
          className="absolute top-1/2 right-0.5 -translate-y-1/2 text-cf-text-muted hover:text-cf-text"
          aria-label="Clear the search"
          onClick={() => {
            onChange("");
          }}
          data-testid={`${testId}-clear`}
        >
          <X aria-hidden />
        </Button>
      )}
    </div>
  );
}

/**
 * Both pages' toolbar: the search, any chips, the Browse all toggle (the marketplace alone,
 * with how many it has while pressed) and the page's ⋯ menu.
 */
export function CatalogToolbar({
  search,
  chips,
  browse,
  menu,
  testId,
}: {
  search: { value: string; placeholder: string; label: string; onChange: (text: string) => void };
  chips?: ReactNode;
  browse: { on: boolean; count: number | null; onToggle: () => void };
  menu: { label: string; items: readonly OverflowItem[]; busy: boolean };
  testId: string;
}) {
  return (
    <div className="mt-3 flex min-w-0 flex-wrap items-center gap-2" data-testid={`${testId}-toolbar`}>
      <SearchField {...search} testId={`${testId}-search`} />
      {chips}
      <Button
        variant="outline"
        size="xs"
        className={cn("shrink-0 bg-transparent dark:bg-transparent", browse.on && "bg-cf-control-hover dark:bg-cf-control-hover/50")}
        aria-pressed={browse.on}
        onClick={browse.onToggle}
        data-testid={`${testId}-browse-all`}
      >
        {browse.on && <Check aria-hidden />}
        Browse all
        {browse.on && browse.count !== null && <span className="font-normal text-cf-text-muted tabular-nums">{countWords(browse.count)}</span>}
      </Button>
      <OverflowMenu label={menu.label} items={menu.items} busy={menu.busy} testId={`${testId}-menu`} tabbable triggerClassName="border border-cf-border" />
    </div>
  );
}
