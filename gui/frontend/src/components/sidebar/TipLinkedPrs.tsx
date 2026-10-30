import { prStateText } from "@/components/pr/tones";
import { prStateLook } from "@/components/prs/prState";
import { cn } from "@/lib/utils";
import { linkedPrCardRows } from "./linkedPrTag";
import { useLinkedPrFacts, useLinkKeys } from "./useLinkedPrs";

/**
 * The thread card's linked pull requests, below a hairline (docs/notes/sidebar-thread-card.md):
 * one row each, newest linked first, the state icon
 * and the number in the state's colour, then the title (the bare number while it is unknown).
 * Closed ones are left out, as in the row's tag; at most LINKED_PR_TIP_CAP, then "+N more".
 * Nothing, not even the hairline, when none is left. Mounted only while the card is open.
 */
export function TipLinkedPrs({ id }: { id: string }) {
  const keys = useLinkKeys(id);
  const facts = useLinkedPrFacts(keys);
  const { rows, more } = linkedPrCardRows(facts);
  if (rows.length === 0) return null;
  return (
    <div data-testid="tip-prs">
      <div className="-mx-2.5 my-1.5 h-px bg-cf-border" aria-hidden />
      {rows.map((pr, i) => {
        const look = prStateLook(pr.state === "draft" ? "open" : pr.state === "unknown" ? null : pr.state, pr.state === "draft");
        const tone = prStateText[look.tone];
        return (
          <div key={`${String(pr.number)}:${String(i)}`} className="flex items-center gap-2 leading-5" data-testid="tip-pr" data-state={pr.state}>
            <look.icon className={cn("size-3.5 shrink-0", tone)} aria-label={look.label} />
            <span className={cn("shrink-0 tabular-nums", tone)}>#{pr.number}</span>
            {pr.title && <span className="min-w-0 truncate">{pr.title}</span>}
          </div>
        );
      })}
      {more > 0 && (
        <div className="leading-5 text-cf-text-muted" data-testid="tip-prs-more">
          +{more} more
        </div>
      )}
    </div>
  );
}
