import { Button } from "@/components/ui/button";

/**
 * The question a page no thread owns puts to the user, once, between the File tab's header
 * and the page (docs/notes/page-ownership-gui.md, sketch B "band"): shown only after the page
 * loaded the bridge and said hello, so a plain HTML file is never asked about. The page shows
 * behind it either way, its bridge calls waiting for the answer. The answer is kept per file
 * by the daemon (page.allow, page.disallow) and the band goes; the footer is where it changes.
 */
export function PageConsentBand({ busy, onAnswer }: { busy: boolean; onAnswer: (allow: boolean) => void }) {
  return (
    <div className="flex shrink-0 flex-wrap items-center gap-x-3 gap-y-2 border-b border-cf-divider bg-cf-surface-raised px-3 py-2" role="region" aria-label="Let this page use Code Foundry?" data-testid="page-consent">
      <div className="flex min-w-48 flex-1 flex-col gap-0.5">
        <p className="text-body font-medium">Let this page use Code Foundry?</p>
        <p className="text-body-sm text-cf-text-muted">It could read your threads and projects, run commands when you click in it, and fetch web addresses through the app, including ones on your network.</p>
      </div>
      <div className="ml-auto flex shrink-0 gap-2">
        <Button
          variant="outline"
          size="xs"
          disabled={busy}
          onClick={() => {
            onAnswer(false);
          }}
          data-testid="page-consent-deny"
        >
          Don&apos;t allow
        </Button>
        <Button
          size="xs"
          disabled={busy}
          onClick={() => {
            onAnswer(true);
          }}
          data-testid="page-consent-allow"
        >
          Allow
        </Button>
      </div>
    </div>
  );
}
