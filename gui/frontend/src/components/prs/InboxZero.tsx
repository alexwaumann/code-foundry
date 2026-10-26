import type { PullRequestView } from "@/api/gh";
import { Flame } from "@/components/ember/Flame";
import { useNowSelect } from "@/lib/clock";
import type { AuthoredRow } from "./authoredStatus";
import { EMBER_TITLE, emberLine } from "./emberLine";

/** Day number (local), so the quiet line re-renders once a day at most. */
const today = (now: number): number => {
  const d = new Date(now);
  return new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime();
};

/** "Needs your review" when nothing does: Ember, pleased, with one line about the viewer's own pull requests. */
export function InboxZero({ authored, merged, viewer }: { authored: readonly AuthoredRow[]; merged: readonly PullRequestView[]; viewer: string }) {
  const day = useNowSelect(60_000, today);
  const line = emberLine(authored, merged, viewer, new Date(day));
  return (
    <div className="flex items-center gap-5 rounded-lg border px-6 py-6" data-testid="prs-inbox-zero">
      <Flame state="idle" size="hero" className="shrink-0" />
      <div className="min-w-0">
        <p className="text-title">{EMBER_TITLE}</p>
        <p className="mt-0.5 text-body-sm text-cf-text-muted" data-testid="prs-ember-line">
          {line}
        </p>
      </div>
    </div>
  );
}
