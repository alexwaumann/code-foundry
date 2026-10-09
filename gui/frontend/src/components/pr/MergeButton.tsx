import { ChevronDown, GitMerge, Loader2 } from "lucide-react";
import { useId, useMemo, useState } from "react";
import type { PullRequestDetailView } from "@/api/gh";
import { DropdownMenu, DropdownMenuCheckboxItem, DropdownMenuContent, DropdownMenuItem, DropdownMenuLabel, DropdownMenuSeparator, DropdownMenuTrigger } from "@/components/ui/dropdown-menu";
import { cn } from "@/lib/utils";
import { pullRequestKey } from "@/stores/gh";
import { mergePullRequest, usePrPanelStore } from "@/stores/prPanel";
import type { PrRef } from "@/surfaces/pullrequestTarget";
import { POPUP_COLLISION_PADDING, POPUP_FIT, stopPlainKeys, usePanelBoundary } from "./keys";
import { branchDelete, MERGE_METHOD_LABELS, mergeAvailability, mergeMethodHint } from "./merge";

/**
 * The header's Merge button, left of the ⋯ menu: a dropdown of the methods the repository
 * allows and "Delete branch after merge" (origin's branch only; on unless it cannot be
 * deleted). Choosing a method runs pr.merge with the head shown (the daemon's
 * confirmation goes through the confirm dialog), with a spinner until it answers. Shown
 * only for an open pull request; disabled, with the reason as its tooltip, when GitHub
 * would refuse (draft, conflicts, blocked, no write access, no method). Below 340px it
 * keeps its icons only.
 */
export function MergeButton({ prRef, detail }: { prRef: PrRef; detail: PullRequestDetailView }) {
  const a = useMemo(() => mergeAvailability(detail), [detail]);
  const busy = usePrPanelStore((s) => s.merging[pullRequestKey(prRef.slug, prRef.number)] ?? false);
  const [open, setOpen] = useState(false);
  const del = branchDelete(detail);
  const deletable = del.deletable;
  const [deleteBranch, setDeleteBranch] = useState(true);
  const { ref, boundary } = usePanelBoundary();
  const reasonId = useId();
  if (!a.visible) return null;
  const blocked = a.reason !== null || busy;
  const pr = detail.pullRequest;
  return (
    <DropdownMenu
      modal={false}
      open={open && !blocked}
      onOpenChange={(next) => {
        // A disabled button stays focusable (its tooltip says why) but opens nothing.
        if (!next || !blocked) setOpen(next);
      }}
    >
      <DropdownMenuTrigger asChild>
        <button
          ref={ref}
          type="button"
          data-testid="pr-merge-button"
          aria-label={busy ? "Merging…" : "Merge"}
          aria-disabled={blocked || undefined}
          aria-busy={busy || undefined}
          aria-describedby={a.reason ? reasonId : undefined}
          data-reason={a.reason ?? undefined}
          title={a.reason ?? (busy ? "Merging…" : `Merge into ${pr.baseRef}`)}
          className={cn(
            "flex h-7 shrink-0 items-center gap-1 rounded-md bg-primary pr-1.5 pl-2 text-[13px] font-medium text-primary-foreground shadow-xs outline-none hover:bg-primary/90 focus-visible:ring-2 focus-visible:ring-ring/60 @max-[340px]:pl-1.5",
            blocked && "cursor-default hover:bg-primary",
            a.reason !== null && "opacity-50",
          )}
        >
          {busy ? <Loader2 className="size-3.5 animate-spin" aria-hidden /> : <GitMerge className="size-3.5" aria-hidden />}
          <span className="@max-[340px]:sr-only">Merge</span>
          <ChevronDown className="size-3.5 opacity-80" aria-hidden />
          {a.reason && (
            <span id={reasonId} className="sr-only">
              {a.reason}
            </span>
          )}
        </button>
      </DropdownMenuTrigger>
      <DropdownMenuContent
        align="end"
        collisionBoundary={boundary}
        collisionPadding={POPUP_COLLISION_PADDING}
        className={cn("w-72", POPUP_FIT)}
        data-testid="pr-merge-menu"
        data-region="panel"
        onKeyDown={stopPlainKeys}
      >
        <DropdownMenuLabel className="truncate" title={`Merge into ${pr.baseRef}`}>
          Merge into <span className="font-mono">{pr.baseRef}</span>
        </DropdownMenuLabel>
        {a.notes.map((n) => (
          <p key={n} className="px-2 pb-1.5 text-xs text-amber-700 dark:text-amber-300" data-testid="pr-merge-note">
            {n}
          </p>
        ))}
        {a.methods.map((m) => (
          <DropdownMenuItem
            key={m}
            data-testid={`pr-merge-method-${m}`}
            onSelect={() => {
              // Closed here, not by Radix: the merge makes the button busy in this same
              // event, so the controlled `open` is already false and Radix would skip
              // onOpenChange, leaving `open` set to reopen the menu once the merge ends.
              setOpen(false);
              void mergePullRequest(prRef, m, deleteBranch && deletable, pr.headSha);
            }}
          >
            <span className="flex min-w-0 flex-1 flex-col">
              <span>{MERGE_METHOD_LABELS[m]}</span>
              <span className="text-xs text-muted-foreground">{mergeMethodHint(m, detail.commitCount, pr.baseRef)}</span>
            </span>
          </DropdownMenuItem>
        ))}
        <DropdownMenuSeparator />
        <DropdownMenuCheckboxItem
          data-testid="pr-merge-delete-branch"
          // pl-9: the box sits 12px from the menu's edge (4px menu padding + 8px); leave
          // the same 12px between it and the label.
          className="pl-9"
          checked={deleteBranch && deletable}
          disabled={!deletable}
          onCheckedChange={(v) => {
            setDeleteBranch(v);
          }}
          // Stay open: it is a setting for the method chosen next.
          onSelect={(e) => {
            e.preventDefault();
          }}
        >
          <span className="flex min-w-0 flex-1 flex-col">
            <span>Delete branch after merge</span>
            <span className="text-xs [overflow-wrap:anywhere] text-muted-foreground" data-testid="pr-merge-delete-branch-note">
              {del.subtitle}
            </span>
          </span>
        </DropdownMenuCheckboxItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
