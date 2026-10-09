import { useState } from "react";
import { Check, Loader2, Search, UserPlus } from "lucide-react";
import type { ReviewerCandidateView } from "@/api/gh";
import { Command, CommandEmpty, CommandGroup, CommandInput, CommandItem, CommandList } from "@/components/ui/command";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { pullRequestKey } from "@/stores/gh";
import { requestingKey, reviewerCandidatesResource, setReviewRequest, usePrPanelStore } from "@/stores/prPanel";
import { useResource } from "@/stores/resource";
import type { PrRef } from "@/surfaces/pullrequestTarget";
import { Avatar } from "./Avatar";
import { stopPlainKeys } from "./keys";

export const WRITE_ACCESS_HINT = "Asking someone to review needs write access on this repository.";

function CandidateRow({ prRef, c }: { prRef: PrRef; c: ReviewerCandidateView }) {
  const busy = usePrPanelStore((s) => s.requesting[requestingKey(prRef, c.login)] ?? false);
  return (
    <CommandItem
      value={`${c.login} ${c.name}`}
      data-testid="pr-reviewer-candidate"
      data-login={c.login}
      data-requested={c.isRequested}
      onSelect={() => void setReviewRequest(prRef, c.login, c.kind, !c.isRequested)}
    >
      <Avatar login={c.login} src={c.avatarUrl} size={20} />
      <span className="truncate">{c.login}</span>
      {c.name && <span className="truncate text-xs text-muted-foreground">{c.name}</span>}
      <span className="ml-auto flex size-4 items-center justify-center">
        {busy ? <Loader2 className="size-3.5 animate-spin" aria-label="Updating" /> : c.isRequested ? <Check className="size-3.5 text-foreground" aria-label="Requested" /> : null}
      </span>
    </CommandItem>
  );
}

/** Mounted only while the popover is open: watching the resource reads the candidates on open. */
function Candidates({ prRef }: { prRef: PrRef }) {
  const entry = useResource(reviewerCandidatesResource, pullRequestKey(prRef.slug, prRef.number));
  const list = entry?.data?.candidates ?? null;
  return (
    <Command className="bg-transparent" loop>
      <CommandInput placeholder="Search people with access" autoFocus className="h-9" data-testid="pr-reviewer-search" />
      <CommandList className="max-h-72 p-1">
        {list === null ? (
          <p className="px-2 py-3 text-sm text-muted-foreground">{entry?.error ? `Cannot list people: ${entry.error}` : "Loading…"}</p>
        ) : list.length === 0 ? (
          <p className="px-2 py-3 text-sm text-muted-foreground" data-testid="pr-reviewer-nobody">
            Nobody else has access to this repository.
          </p>
        ) : (
          <>
            <CommandEmpty className="px-2 py-3 text-sm text-muted-foreground">No one matches.</CommandEmpty>
            <CommandGroup className="p-0">
              {list.map((c) => (
                <CandidateRow key={c.id || c.login} prRef={prRef} c={c} />
              ))}
            </CommandGroup>
            {entry?.data?.truncated && <p className="px-2 pt-1 pb-1.5 text-xs text-muted-foreground">Showing the first 100 people. Search narrows them.</p>}
          </>
        )}
      </CommandList>
    </Command>
  );
}

/**
 * The add-reviewer button and its picker (T3 Code's): people with access, requested ones
 * first with a check; choosing one requests or withdraws a review (pr.review.request).
 * Without write access it explains why instead of listing anyone.
 */
export function ReviewerPicker({ prRef, canUpdate }: { prRef: PrRef; canUpdate: boolean }) {
  const [open, setOpen] = useState(false);
  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <button
          type="button"
          aria-label="Request a review"
          title={canUpdate ? "Request a review" : WRITE_ACCESS_HINT}
          data-testid="pr-add-reviewer"
          className="flex size-6 shrink-0 items-center justify-center rounded-md text-muted-foreground outline-none hover:bg-accent hover:text-foreground focus-visible:ring-1 focus-visible:ring-ring data-[state=open]:bg-accent"
        >
          <UserPlus className="size-3.5" aria-hidden />
        </button>
      </PopoverTrigger>
      <PopoverContent align="start" className="w-72 overflow-hidden p-0" data-testid="pr-reviewer-picker" data-region="panel" onKeyDown={stopPlainKeys}>
        {canUpdate ? (
          <Candidates prRef={prRef} />
        ) : (
          <div>
            <div className="flex h-9 items-center gap-2 border-b px-3 text-sm text-muted-foreground">
              <Search className="size-4 shrink-0 opacity-50" aria-hidden />
              <span className="opacity-60">Search people with access</span>
            </div>
            <p className="px-3 py-3 text-sm text-muted-foreground" data-testid="pr-reviewer-readonly">
              {WRITE_ACCESS_HINT}
            </p>
          </div>
        )}
      </PopoverContent>
    </Popover>
  );
}
