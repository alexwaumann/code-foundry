import type { ReactNode } from "react";
import { Check, Copy, FolderSearch, RefreshCw, SquareArrowOutUpRight, WrapText, type LucideIcon } from "lucide-react";
import { Segmented } from "@/components/usage/Segmented";
import { Button } from "@/components/ui/button";
import { Tip } from "@/components/ui/tooltip";
import { useCopied } from "@/lib/useCopied";
import { cn } from "@/lib/utils";
import { setWrap, useCodeViewStore } from "@/stores/codeView";
import { openInEditor, revealInFinder, type FilePlace } from "./fileActions";

/**
 * The File and Diff tabs' header ("header A", docs/notes/file-viewer-3-tabs.md): row one
 * is the file's icon, name and directory (the full path in a tooltip: the row shows it
 * relative, or cut from the left) with the actions at the right; row two is the tab's
 * mode switches and meta. The library's own file header stays off.
 */
export function FileHeader({ icon: Icon, name, dir, fullPath, actions, children }: { icon: LucideIcon; name: string; dir: string; fullPath: string; actions: ReactNode; children: ReactNode }) {
  return (
    <header className="flex shrink-0 flex-col gap-1 border-b border-cf-divider px-3 pt-2 pb-1.5" data-testid="file-header">
      <div className="flex h-7 min-w-0 items-center gap-2">
        <Icon className="size-4 shrink-0 text-cf-text-muted" aria-hidden />
        <Tip label={fullPath} align="start">
          <span className="flex min-w-0 flex-1 items-baseline gap-2" data-testid="file-header-path">
            <span className="max-w-full shrink-0 truncate text-heading" data-testid="file-header-name">
              {name}
            </span>
            {dir && (
              // Truncates from the left (rtl box; the LRMs keep its slashes in place), so the part next to the name stays.
              <span className="min-w-0 truncate text-left text-caption font-mono [direction:rtl]" data-testid="file-header-dir">{`‎${dir}‎`}</span>
            )}
          </span>
        </Tip>
        <div className="ml-auto flex shrink-0 items-center gap-0.5">{actions}</div>
      </div>
      <div className="flex h-7 min-w-0 items-center gap-2" data-testid="file-header-bar">
        {children}
      </div>
    </header>
  );
}

/** One icon button of the header's actions; the label is its tooltip and accessible name. */
export function HeaderAction({ icon: Icon, label, onClick, testId, pressed }: { icon: LucideIcon; label: string; onClick: () => void; testId?: string; pressed?: boolean }) {
  return (
    <Tip label={label}>
      <Button
        variant="ghost"
        size="icon-xs"
        className={cn("text-cf-text-muted hover:text-cf-text", pressed && "bg-cf-control-hover text-cf-text")}
        aria-label={label}
        aria-pressed={pressed}
        data-testid={testId}
        onClick={onClick}
      >
        <Icon aria-hidden />
      </Button>
    </Tip>
  );
}

/** Copy path: copies the absolute path; a check for a moment after. */
export function CopyPathAction({ path }: { path: string }) {
  const { copied, copy } = useCopied();
  return (
    <HeaderAction
      icon={copied ? Check : Copy}
      label={copied ? "Copied" : "Copy path"}
      testId="file-copy-path"
      onClick={() => {
        void copy(path);
      }}
    />
  );
}

/** Copy path, Open in editor, Reveal in Finder and Refresh: row one's actions. */
export function FileActions({ place, line, onRefresh, extra }: { place: FilePlace; line?: number; onRefresh: () => void; extra?: ReactNode }) {
  return (
    <>
      {extra}
      <CopyPathAction path={place.file} />
      <HeaderAction
        icon={SquareArrowOutUpRight}
        label="Open in editor"
        testId="file-open-editor"
        onClick={() => {
          openInEditor(place, line);
        }}
      />
      <HeaderAction
        icon={FolderSearch}
        label="Reveal in Finder"
        testId="file-reveal"
        onClick={() => {
          revealInFinder(place);
        }}
      />
      <HeaderAction icon={RefreshCw} label="Refresh" testId="file-refresh" onClick={onRefresh} />
    </>
  );
}

/** The wrap toggle at the end of row two (codeView store `wrap`, for every code view). */
export function WrapToggle() {
  const wrap = useCodeViewStore((s) => s.wrap);
  return (
    <HeaderAction
      icon={WrapText}
      label={wrap ? "Don't wrap lines" : "Wrap lines"}
      pressed={wrap}
      testId="file-wrap"
      onClick={() => {
        setWrap(!wrap);
      }}
    />
  );
}

/** A two-or-more-way switch in row two (the Usage page's segmented control). */
export function ModeSwitch<T extends string>({ options, value, onChange, label, testId }: { options: readonly { value: T; label: string }[]; value: T; onChange: (v: T) => void; label: string; testId: string }) {
  return <Segmented options={options} value={value} onChange={onChange} aria-label={label} data-testid={testId} className="shrink-0" />;
}

/** Row two's muted meta ("120 lines · 4 KB · TypeScript"), truncating first. */
export function HeaderMeta({ children, testId }: { children: ReactNode; testId?: string }) {
  return (
    <span className="min-w-0 truncate text-caption-sm tabular-nums" data-testid={testId}>
      {children}
    </span>
  );
}
