import { Button } from "@/components/ui/button";

/**
 * What a thread said about this Diff tab (view.panel.diff --title, --note), as plain text, and,
 * when it took controls away with --hide, the user's way to bring them back. No thread can
 * lock a user out of the tab.
 */
export function ModelBand({ heading, note, hidden, onReveal }: { heading: string; note: string; hidden: boolean; onReveal: () => void }) {
  return (
    <div className="flex shrink-0 items-start gap-3 border-b border-cf-divider px-4 py-2.5" data-testid="diff-model-band">
      <div className="min-w-0 flex-1">
        {heading && (
          <p className="truncate text-subheading" data-testid="diff-model-title">
            {heading}
          </p>
        )}
        {note && (
          <p className="text-caption break-words" data-testid="diff-model-note">
            {note}
          </p>
        )}
      </div>
      {hidden && (
        <Button variant="ghost" size="sm" className="shrink-0" onClick={onReveal} data-testid="diff-reveal">
          Show controls
        </Button>
      )}
    </div>
  );
}
