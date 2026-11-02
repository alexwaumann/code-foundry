import { useRef } from "react";
import { Ellipsis, SquareArrowOutUpRight } from "lucide-react";
import { AppIcon, FinderIcon } from "@/components/icons/AppIcon";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuSeparator, DropdownMenuTrigger } from "@/components/ui/dropdown-menu";
import { Tip } from "@/components/ui/tooltip";
import { runCommand } from "@/stores/commands";
import { worktreeContext } from "@/stores/context";
import { newTerminalIn } from "@/stores/projectActions";
import { useEditorApps } from "@/stores/threadInfo";

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
 * Details' Path control: "Open in Finder" (the Finder icon and the label; `compact` shows the
 * icon alone, named by its tooltip) reveals the project's main checkout, and its ⋯ opens the
 * thread info card's Open in list for it: Finder, the installed editors (their real icons),
 * then Terminal (a new terminal in the main checkout, in the page's bottom panel). A picked
 * item runs once the menu has closed and the keyboard is back on the page's list
 * (OverflowMenu has why).
 */
export function OpenInFinder({ projectId, path, compact }: { projectId: string; path: string; compact: boolean }) {
  const editors = useEditorApps();
  const moreRef = useRef<HTMLButtonElement>(null);
  const picked = useRef<(() => void) | null>(null);
  const ctx = () => worktreeContext(projectId, path);
  const reveal = () => void runCommand("worktree.reveal", { worktree: path }, ctx());
  const pick = (run: () => void) => () => {
    picked.current = run;
  };
  return (
    <span className="group/split inline-flex min-w-0 items-center" data-testid="details-open-in">
      <Tip label={compact ? "Open in Finder" : null}>
        <button type="button" tabIndex={-1} className={MAIN} aria-label="Open in Finder" data-split-main="" data-testid="details-reveal" onClick={reveal}>
          <FinderIcon aria-hidden />
          {!compact && <span className="truncate">Open in Finder</span>}
        </button>
      </Tip>
      <DropdownMenu modal={false}>
        <Tip label="Open in options">
          <DropdownMenuTrigger asChild>
            <button ref={moreRef} type="button" tabIndex={-1} className={MORE} aria-label="Open in options" data-split-more="" data-testid="details-open-in-more">
              <Ellipsis aria-hidden />
            </button>
          </DropdownMenuTrigger>
        </Tip>
        <DropdownMenuContent
          align="end"
          className="min-w-52"
          data-testid="details-open-in-menu"
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
          <DropdownMenuItem data-testid="details-open-finder" onSelect={pick(reveal)}>
            <FinderIcon aria-hidden />
            Finder
          </DropdownMenuItem>
          {editors.map((a) => (
            <DropdownMenuItem
              key={a.bundleId}
              data-testid="details-open-editor"
              data-app={a.bundleId}
              onSelect={pick(() => void runCommand("worktree.open.editor", { worktree: path, app: a.bundleId }, ctx()))}
            >
              <AppIcon bundleId={a.bundleId} fallback={SquareArrowOutUpRight} />
              {a.name}
            </DropdownMenuItem>
          ))}
          <DropdownMenuSeparator />
          <DropdownMenuItem data-testid="details-open-terminal" onSelect={pick(() => void newTerminalIn(projectId, path))}>
            Terminal
          </DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>
    </span>
  );
}
