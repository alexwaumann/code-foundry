import { useEffect, useState, type ReactNode } from "react";
import { Check, Loader2, Search, UserPlus, X } from "lucide-react";
import type { ReviewerCandidateView } from "@/api/gh";
import { Command, CommandGroup, CommandInput, CommandItem, CommandList } from "@/components/ui/command";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { Tip } from "@/components/ui/tooltip";
import { cn } from "@/lib/utils";
import { clearConfirmedRequests, requestingKey, reviewerCandidatesKey, reviewerCandidatesResource, setReviewRequest, usePrPanelStore } from "@/stores/prPanel";
import { useResource } from "@/stores/resource";
import { addRecentReviewer, removeRecentReviewer, useRecentReviewers, type RecentReviewer } from "@/stores/reviewerRecents";
import type { PrRef } from "@/surfaces/pullrequestTarget";
import { Avatar } from "./Avatar";
import { POPUP_COLLISION_PADDING, POPUP_FIT, stopPlainKeys, usePanelBoundary } from "./keys";
import { matchesReviewerSearch, REVIEWER_SEARCH_MIN_CHARS, reviewerSearchTerm, useReviewerSearchTerm } from "./reviewerSearch";

export const WRITE_ACCESS_HINT = "Asking someone to review needs write access on this repository.";

const sameReviewer = (a: { login: string; kind: string }, b: { login: string; kind: string }): boolean =>
  a.kind === b.kind && a.login.toLowerCase() === b.login.toLowerCase();

/**
 * A requested candidate shown among search results only when it matches the term too:
 * every word in the login or the name, as the daemon filters a search of several words,
 * so a row just requested from the results keeps its place (with its check).
 */
const matches = (c: ReviewerCandidateView, term: string): boolean => matchesReviewerSearch(c.login, c.name, term);

/** Each person once, first entry kept (a requested match is listed among the requests). */
const uniqueCandidates = (list: readonly ReviewerCandidateView[]): ReviewerCandidateView[] => {
  const seen = new Set<string>();
  return list.filter((c) => {
    const k = `${c.kind}:${c.login.toLowerCase()}`;
    if (seen.has(k)) return false;
    seen.add(k);
    return true;
  });
};

function Message({ children, testId }: { children: ReactNode; testId?: string }) {
  return (
    <p className="px-2 py-3 text-body text-cf-text-muted" data-testid={testId}>
      {children}
    </p>
  );
}

/**
 * One person (or requested team): selecting requests a review, or withdraws a pending
 * one. A successful request puts them first in the repository's recents. `onRemove`
 * (Recent rows) adds the × that drops the row from the recents. A change the daemon
 * confirmed shows at once and wins over the candidates (stores/prPanel.ts `confirmed`).
 */
function CandidateRow({ prRef, c, onRemove }: { prRef: PrRef; c: ReviewerCandidateView; onRemove?: () => void }) {
  const busy = usePrPanelStore((s) => s.requesting[requestingKey(prRef, c.login)] ?? false);
  const confirmed = usePrPanelStore((s) => s.confirmed[requestingKey(prRef, c.login)]);
  const isRequested = confirmed ?? c.isRequested;
  const select = () => {
    const requested = !isRequested;
    void setReviewRequest(prRef, c.login, c.kind, requested).then((ok) => {
      if (ok && requested) addRecentReviewer(prRef.slug, c);
    });
  };
  return (
    <CommandItem
      value={`${c.kind}:${c.login}`}
      data-testid="pr-reviewer-candidate"
      data-login={c.login}
      data-requested={isRequested}
      onSelect={select}
    >
      <Avatar login={c.login} src={c.avatarUrl} size={20} />
      <span className="truncate">{c.login}</span>
      {c.name && <span className="truncate text-caption">{c.name}</span>}
      <span className="ml-auto flex size-4 shrink-0 items-center justify-center">
        {busy && confirmed === undefined ? (
          <Loader2 className="size-3.5 animate-spin" aria-label="Updating" />
        ) : isRequested ? (
          <Check className="size-3.5 text-cf-text" aria-label="Requested" />
        ) : onRemove ? (
          <button
            type="button"
            tabIndex={-1}
            aria-label="Remove from recent"
            data-testid="pr-reviewer-recent-remove"
            className="flex size-4 items-center justify-center rounded-sm text-cf-text-muted hover:bg-cf-text/10 hover:text-cf-text"
            // Keep the press to the button: cmdk selects the row on click.
            onPointerDown={(e) => {
              e.preventDefault();
              e.stopPropagation();
            }}
            onClick={(e) => {
              e.preventDefault();
              e.stopPropagation();
              onRemove();
            }}
          >
            <X className="size-3.5" aria-hidden />
          </button>
        ) : null}
      </span>
    </CommandItem>
  );
}

const recentAsCandidate = (r: RecentReviewer): ReviewerCandidateView => ({ id: "", kind: r.kind, login: r.login, name: r.name, avatarUrl: r.avatarUrl, isRequested: false });

/** Under the search threshold: the pending requests, then this repository's recents. */
function RequestedAndRecent({ prRef }: { prRef: PrRef }) {
  const entry = useResource(reviewerCandidatesResource, reviewerCandidatesKey(prRef, ""));
  const recents = useRecentReviewers(prRef.slug);
  const requested = uniqueCandidates((entry?.data?.candidates ?? []).filter((c) => c.isRequested));
  const recent = recents.filter((r) => !requested.some((c) => sameReviewer(c, r)));
  const loaded = entry?.data != null;
  return (
    <>
      {!loaded && <Message>{entry?.error ? `Cannot list requests: ${entry.error}` : "Loading…"}</Message>}
      {requested.length > 0 && (
        <CommandGroup heading="Requested" className="p-0" data-testid="pr-reviewer-requested">
          {requested.map((c) => (
            <CandidateRow key={`${c.kind}:${c.login}`} prRef={prRef} c={c} />
          ))}
        </CommandGroup>
      )}
      {recent.length > 0 && (
        <CommandGroup heading="Recent" className="p-0" data-testid="pr-reviewer-recent">
          {recent.map((r) => (
            <CandidateRow
              key={`${r.kind}:${r.login}`}
              prRef={prRef}
              c={recentAsCandidate(r)}
              onRemove={() => {
                removeRecentReviewer(prRef.slug, r.login, r.kind);
              }}
            />
          ))}
        </CommandGroup>
      )}
      {loaded && requested.length === 0 && recent.length === 0 && (
        <Message testId="pr-reviewer-hint">Type {REVIEWER_SEARCH_MIN_CHARS}+ characters to search</Message>
      )}
    </>
  );
}

/** At or over the threshold: the daemon's matches for term, in its order, each once. */
function SearchResults({ prRef, term }: { prRef: PrRef; term: string }) {
  const entry = useResource(reviewerCandidatesResource, term === "" ? null : reviewerCandidatesKey(prRef, term));
  const data = entry?.data;
  const list = data ? uniqueCandidates(data.candidates.filter((c) => !c.isRequested || matches(c, term))) : null;
  if (list === null) return <Message>{entry?.error ? `Cannot search: ${entry.error}` : "Searching…"}</Message>;
  if (list.length === 0) return <Message testId="pr-reviewer-nomatch">No one matches.</Message>;
  return (
    <CommandGroup className="p-0">
      {list.map((c) => (
        <CandidateRow key={`${c.kind}:${c.login}`} prRef={prRef} c={c} />
      ))}
    </CommandGroup>
  );
}

/** Mounted only while the popover is open: the groups watch their reads while shown. */
function Candidates({ prRef }: { prRef: PrRef }) {
  const [input, setInput] = useState("");
  const { term, pending } = useReviewerSearchTerm(input);
  const searching = reviewerSearchTerm(input) !== "";
  const loading = usePrSearchLoading(prRef, searching ? term : "");
  // Closing the picker forgets its confirmed changes: the next open shows GitHub's state.
  const { slug, number } = prRef;
  useEffect(
    () => () => {
      clearConfirmedRequests({ slug, number });
    },
    [slug, number],
  );
  return (
    <Command className="bg-transparent" loop shouldFilter={false}>
      <CommandInput
        placeholder="Search people with access"
        autoFocus
        className="h-9"
        data-testid="pr-reviewer-search"
        value={input}
        onValueChange={setInput}
        trailing={
          searching && (pending || loading) ? (
            <Loader2 className="size-3.5 shrink-0 animate-spin text-cf-text-muted" aria-label="Searching" data-testid="pr-reviewer-searching" />
          ) : null
        }
      />
      <CommandList className="max-h-72 p-1">{searching ? <SearchResults prRef={prRef} term={term} /> : <RequestedAndRecent prRef={prRef} />}</CommandList>
    </Command>
  );
}

/** Whether the search for term is being read (false for ""). */
function usePrSearchLoading(prRef: PrRef, term: string): boolean {
  const key = term === "" ? null : reviewerCandidatesKey(prRef, term);
  return reviewerCandidatesResource.store((s) => (key === null ? false : (s.entries[key]?.loading ?? false)));
}

/**
 * The add-reviewer button and its picker (T3 Code's): the pending requests (with a
 * check) and recently asked people until 2+ characters are typed, then GitHub's matches
 * for them; choosing one requests or withdraws a review (pr.review.request). Without
 * write access it explains why instead of listing anyone.
 */
export function ReviewerPicker({ prRef, canUpdate }: { prRef: PrRef; canUpdate: boolean }) {
  const [open, setOpen] = useState(false);
  const { ref, boundary } = usePanelBoundary();
  return (
    <Popover open={open} onOpenChange={setOpen}>
      <Tip label={canUpdate ? "Request a review" : WRITE_ACCESS_HINT}>
        <PopoverTrigger asChild>
          <button
            ref={ref}
            type="button"
            aria-label="Request a review"
            data-testid="pr-add-reviewer"
            className="flex size-6 shrink-0 items-center justify-center rounded-md text-cf-text-muted outline-none hover:bg-cf-control-hover hover:text-cf-text focus-visible:ring-1 focus-visible:ring-cf-focus aria-expanded:bg-cf-control-hover"
          >
            <UserPlus className="size-3.5" aria-hidden />
          </button>
        </PopoverTrigger>
      </Tip>
      <PopoverContent
        align="start"
        collisionBoundary={boundary}
        collisionPadding={POPUP_COLLISION_PADDING}
        className={cn("w-72 overflow-hidden p-0", POPUP_FIT)}
        data-testid="pr-reviewer-picker"
        data-region="panel"
        onKeyDown={stopPlainKeys}
      >
        {canUpdate ? (
          <Candidates prRef={prRef} />
        ) : (
          <div>
            <div className="flex h-9 items-center gap-2 border-b px-3 text-body text-cf-text-muted">
              <Search className="size-4 shrink-0 opacity-50" aria-hidden />
              <span className="opacity-60">Search people with access</span>
            </div>
            <p className="px-3 py-3 text-body text-cf-text-muted" data-testid="pr-reviewer-readonly">
              {WRITE_ACCESS_HINT}
            </p>
          </div>
        )}
      </PopoverContent>
    </Popover>
  );
}
