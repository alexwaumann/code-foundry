import { ChevronRight } from "lucide-react";
import { cn } from "@/lib/utils";
import { openThemes } from "@/stores/views";

/** A row that opens somewhere else: title and description on the left, a chevron on the right. */
export function LinkRow({ title, description, onClick, className, testId }: { title: string; description: string; onClick: () => void; className?: string | undefined; testId?: string }) {
  return (
    <button
      type="button"
      className={cn("flex w-full items-center gap-6 px-4 py-3 text-left outline-none hover:bg-accent/50 focus-visible:bg-accent/50", className)}
      onClick={onClick}
      data-testid={testId}
    >
      <span className="min-w-0 flex-1">
        <span className="block text-label">{title}</span>
        <span className="mt-0.5 block text-caption">{description}</span>
      </span>
      <ChevronRight className="size-4 shrink-0 text-muted-foreground" aria-hidden />
    </button>
  );
}

/** Appearance › Theme: the Themes page (theme.pick), a page of its own. Closing it comes back here. */
export function BrowseThemesRow({ className }: { className?: string | undefined }) {
  return (
    <LinkRow
      title="Browse themes"
      description="Preview every theme in a gallery of the app's controls, then apply one."
      className={className}
      testId="settings-themes-link"
      onClick={() => {
        openThemes(undefined, "settings");
      }}
    />
  );
}
