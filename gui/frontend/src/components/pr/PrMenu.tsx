import { ArrowUpRight, BookOpen, Ellipsis, Hammer, Link2, Loader2, MessageCircleQuestion, RefreshCw, Undo2 } from "lucide-react";
import type { ReactNode } from "react";
import type { PullRequestDetailView } from "@/api/gh";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuSeparator, DropdownMenuShortcut, DropdownMenuTrigger } from "@/components/ui/dropdown-menu";
import { updatedAgo } from "@/components/prs/format";
import { formatChord } from "@/keys/chord";
import { useNow } from "@/lib/clock";
import { cn } from "@/lib/utils";
import { openUrl, pullRequestKey, useFreshness } from "@/stores/gh";
import { copyPullRequestLink, refreshPullRequest, revertPullRequest, usePrPanelStore } from "@/stores/prPanel";
import type { PrRef } from "@/surfaces/pullrequestTarget";
import { COPY_LINK_CHORD, POPUP_COLLISION_PADDING, POPUP_FIT, stopPlainKeys, usePanelBoundary } from "./keys";

function Item({ icon, title, hint, children }: { icon: ReactNode; title: string; hint?: ReactNode; children?: ReactNode }) {
  return (
    <>
      {icon}
      <span className="flex min-w-0 flex-1 flex-col">
        <span>{title}</span>
        {hint && <span className="text-xs text-muted-foreground">{hint}</span>}
      </span>
      {children}
    </>
  );
}

function RefreshHint({ fetchedAtMs, lastError, busy }: { fetchedAtMs: number | null; lastError: string; busy: boolean }) {
  const now = useNow(1000);
  const f = useFreshness(fetchedAtMs, lastError, false);
  if (busy) return <span data-testid="pr-menu-refresh-hint">Refreshing…</span>;
  const when = f.fetchedAtMs === null ? "Not fetched yet" : `U${updatedAgo(f.fetchedAtMs, now).slice(1)}`;
  return (
    <span data-testid="pr-menu-refresh-hint" className={f.lastError ? "text-amber-600 dark:text-amber-300" : undefined} title={f.lastError || undefined}>
      {when}
      {f.lastError && " · last fetch failed"}
    </span>
  );
}

/** "Coming next" slots: the AI actions arrive in the next chunk. */
const comingNext = "Coming next";

/** The header's ⋯ menu, in T3 Code's order. Every action is a registry command or a store action. */
export function PrMenu({ prRef, detail, panelKey }: { prRef: PrRef; detail: PullRequestDetailView; panelKey: string }) {
  const busy = usePrPanelStore((s) => s.refreshing[pullRequestKey(prRef.slug, prRef.number)] ?? false);
  const pr = detail.pullRequest;
  const url = pr.url || `https://github.com/${prRef.slug}/pull/${String(prRef.number)}`;
  const canRevert = pr.state === "merged" && detail.viewerCanUpdate;
  const { ref, boundary } = usePanelBoundary();
  return (
    <DropdownMenu modal={false}>
      <DropdownMenuTrigger asChild>
        <button
          ref={ref}
          type="button"
          aria-label="Pull request actions"
          title="More actions"
          data-testid="pr-menu-button"
          className="flex size-7 items-center justify-center rounded-md text-muted-foreground outline-none hover:bg-accent hover:text-foreground focus-visible:ring-1 focus-visible:ring-ring data-[state=open]:bg-accent"
        >
          <Ellipsis className="size-4" aria-hidden />
        </button>
      </DropdownMenuTrigger>
      <DropdownMenuContent
        align="end"
        collisionBoundary={boundary}
        collisionPadding={POPUP_COLLISION_PADDING}
        className={cn("w-80", POPUP_FIT)}
        data-testid="pr-menu"
        data-region="panel"
        onKeyDown={stopPlainKeys}
      >
        <DropdownMenuItem
          data-testid="pr-menu-refresh"
          onSelect={(e) => {
            // Stay open: the item shows the refresh's progress and then its time.
            e.preventDefault();
            void refreshPullRequest(prRef);
          }}
        >
          <Item icon={busy ? <Loader2 className="animate-spin" aria-hidden /> : <RefreshCw aria-hidden />} title="Refresh" hint={<RefreshHint fetchedAtMs={detail.fetchedAtMs} lastError={detail.lastError} busy={busy} />} />
        </DropdownMenuItem>
        <DropdownMenuItem disabled title={comingNext} data-testid="pr-menu-ask">
          <Item icon={<MessageCircleQuestion aria-hidden />} title="Ask a question" hint="Opens a thread that knows which pull request you mean." />
        </DropdownMenuItem>
        <DropdownMenuItem disabled title={comingNext} data-testid="pr-menu-explain">
          <Item icon={<BookOpen aria-hidden />} title="Explain this PR" hint="A walk through the diff and what to read closely." />
        </DropdownMenuItem>
        <DropdownMenuItem disabled title={comingNext} data-testid="pr-menu-fix">
          <Item icon={<Hammer aria-hidden />} title="Fix findings in a thread" />
        </DropdownMenuItem>
        <DropdownMenuSeparator />
        <DropdownMenuItem data-testid="pr-menu-open" onSelect={() => void openUrl(url)}>
          <Item icon={<ArrowUpRight aria-hidden />} title="Open on GitHub" />
        </DropdownMenuItem>
        <DropdownMenuItem data-testid="pr-menu-copy" onSelect={() => void copyPullRequestLink(prRef, url)}>
          <Item icon={<Link2 aria-hidden />} title="Copy link">
            <DropdownMenuShortcut>{formatChord(COPY_LINK_CHORD)}</DropdownMenuShortcut>
          </Item>
        </DropdownMenuItem>
        {canRevert && (
          <>
            <DropdownMenuSeparator />
            <DropdownMenuItem data-testid="pr-menu-revert" onSelect={() => void revertPullRequest(prRef, panelKey)}>
              <Item icon={<Undo2 aria-hidden />} title="Revert changes" hint={`Opens a pull request that reverses #${String(prRef.number)}.`} />
            </DropdownMenuItem>
          </>
        )}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
