import { useRef } from "react";
import type { EditorAppView } from "@/api/gitops";
import { Ellipsis, SquareArrowOutUpRight } from "lucide-react";
import { AppIcon, FinderIcon } from "@/components/icons/AppIcon";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuSeparator, DropdownMenuTrigger } from "@/components/ui/dropdown-menu";
import { Tip } from "@/components/ui/tooltip";
import { useEditorApps } from "@/stores/threadInfo";
import { checkoutOpenIn, type OpenInTarget } from "./openIn";
import type { MenuParts } from "./OverflowMenu";

const DROPDOWN_PARTS: MenuParts = { Item: DropdownMenuItem, Separator: DropdownMenuSeparator };

/**
 * The Open in list for a folder (openIn.ts: a checkout, a workspace's folder), the same in a
 * dropdown (Details' ⋯ here) and a menu's split Open in Finder item (OpenInMenuItem.tsx):
 * Finder, the installed editors (their real icons), a separator, then Terminal (a new
 * terminal there; left out when the target has no place for one).
 * `editors` comes from the always-mounted control (useEditorApps), so the list is read before
 * the menu opens.
 * `parts` are the menu's item and separator; each item records its action in `onPick`, to
 * run once the menu has closed. Test ids `<testIdPrefix>-finder`, `-editor` (data-app), `-terminal`.
 */
export function OpenInList({
  target,
  editors,
  parts: { Item, Separator },
  onPick,
  testIdPrefix,
}: {
  target: OpenInTarget;
  editors: readonly EditorAppView[];
  parts: MenuParts;
  onPick: (run: () => void) => void;
  testIdPrefix: string;
}) {
  const terminal = target.terminal;
  return (
    <>
      <Item data-testid={`${testIdPrefix}-finder`} onSelect={() => { onPick(target.reveal); }}>
        <FinderIcon aria-hidden />
        Finder
      </Item>
      {editors.map((a) => (
        <Item
          key={a.bundleId}
          data-testid={`${testIdPrefix}-editor`}
          data-app={a.bundleId}
          onSelect={() => { onPick(() => { target.openWith(a.bundleId); }); }}
        >
          <AppIcon bundleId={a.bundleId} fallback={SquareArrowOutUpRight} />
          {a.name}
        </Item>
      ))}
      {terminal && (
        <>
          <Separator />
          <Item data-testid={`${testIdPrefix}-terminal`} onSelect={() => { onPick(terminal); }}>
            Terminal
          </Item>
        </>
      )}
    </>
  );
}

/**
 * The split hover (docs/notes/thread-info-split-hover.md) on two real buttons with a 2px
 * seam: the one under the pointer is bright, the other half strength; while the menu is up
 * only the ellipsis is lit, wherever the pointer is (`!`: the group rules count their
 * `:has()` argument and would beat the plain ones).
 */
const MAIN =
  "inline-flex h-7 min-w-0 items-center gap-1.5 rounded-l-md px-2 text-body-sm text-cf-text-secondary outline-none hover:bg-cf-control-hover hover:text-cf-text focus-visible:bg-cf-control-hover focus-visible:text-cf-text group-has-[[data-split-more]:hover]/split:bg-cf-control-hover/50 group-has-[[data-split-more][aria-expanded=true]]/split:bg-transparent! [&_svg]:size-4";
const MORE =
  "ml-0.5 flex h-7 w-6 shrink-0 items-center justify-center rounded-r-md text-cf-text-muted outline-none group-has-[[data-split-main]:hover]/split:bg-cf-control-hover/50 hover:bg-cf-control-hover hover:text-cf-text focus-visible:bg-cf-control-hover focus-visible:text-cf-text aria-expanded:bg-cf-control-hover! aria-expanded:text-cf-text [&_svg]:size-3.5";

/**
 * A Details row's Open in Finder control: "Open in Finder" (the Finder icon and the label;
 * `compact` shows the icon alone, named by its tooltip) reveals the target, and its ⋯ opens
 * the thread info card's Open in list for it: Finder, the installed editors (their real
 * icons), then Terminal (a new terminal there, as a tab). A picked item runs
 * once the menu has closed and the keyboard is back on the page's list (OverflowMenu has
 * why). Test ids `<testId>-open-in`, `-reveal`, `-open-in-more`, `-open-in-menu`, the list's `-open-*`.
 */
export function OpenInSplit({ target, compact, testId }: { target: OpenInTarget; compact: boolean; testId: string }) {
  const editors = useEditorApps();
  const moreRef = useRef<HTMLButtonElement>(null);
  const picked = useRef<(() => void) | null>(null);
  return (
    <span className="group/split inline-flex min-w-0 items-center" data-testid={`${testId}-open-in`}>
      <Tip label={compact ? "Open in Finder" : null}>
        <button type="button" tabIndex={-1} className={MAIN} aria-label="Open in Finder" data-split-main="" data-testid={`${testId}-reveal`} onClick={target.reveal}>
          <FinderIcon aria-hidden />
          {!compact && <span className="truncate">Open in Finder</span>}
        </button>
      </Tip>
      <DropdownMenu modal={false}>
        <Tip label="Open in options">
          <DropdownMenuTrigger asChild>
            <button ref={moreRef} type="button" tabIndex={-1} className={MORE} aria-label="Open in options" data-split-more="" data-testid={`${testId}-open-in-more`}>
              <Ellipsis aria-hidden />
            </button>
          </DropdownMenuTrigger>
        </Tip>
        <DropdownMenuContent
          align="end"
          className="min-w-52"
          data-testid={`${testId}-open-in-menu`}
          onKeyDown={(e) => {
            e.stopPropagation();
          }}
          onCloseAutoFocus={(e) => {
            e.preventDefault();
            const active = document.activeElement;
            if (!active || active === document.body || active === moreRef.current) {
              moreRef.current?.closest<HTMLElement>("[data-focus-root]")?.focus({ preventScroll: true });
            }
            const run = picked.current;
            picked.current = null;
            run?.();
          }}
        >
          <OpenInList target={target} editors={editors} parts={DROPDOWN_PARTS} onPick={(run) => { picked.current = run; }} testIdPrefix={`${testId}-open`} />
        </DropdownMenuContent>
      </DropdownMenu>
    </span>
  );
}

/** Details' Path control on a project's page: OpenInSplit for its main checkout. */
export function OpenInFinder({ projectId, path, compact }: { projectId: string; path: string; compact: boolean }) {
  return <OpenInSplit target={checkoutOpenIn(projectId, path)} compact={compact} testId="details" />;
}
