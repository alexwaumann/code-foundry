import { useState } from "react";
import { ShieldCheck, TriangleAlert } from "lucide-react";
import { Button } from "@/components/ui/button";
import { tildify } from "@/lib/path";
import type { PageError } from "@/lib/pageErrors";
import { cn } from "@/lib/utils";
import { answerPage } from "@/stores/pageAnswers";
import { useThreadsStore } from "@/stores/threads";
import { HtmlFrame } from "./HtmlFrame";
import { PageConsentBand } from "./PageConsentBand";
import { PageErrors } from "./PageErrors";
import { usePreviewGrant } from "./previewGrant";
import { usePageThread } from "./usePageThread";
import { FileEmptyState, FileLoading } from "./states";

/**
 * An HTML file rendered live: the daemon serves it, and everything under its scope (its
 * checkout, else its directory; the file alone when that directory is home or another
 * folder too broad to hand a page), at a granted URL (FilesystemService.PreviewFile), so its
 * scripts run and its relative links, stylesheets, scripts and images resolve; the network
 * is open for CDNs. A srcdoc frame could do none of that: its links resolved against the
 * app's own URL and navigated the frame into the app's blank shell (docs/notes/
 * html-preview-interactive.md). The frame (HtmlFrame, shared with a thread's inline pages)
 * reloads when the file's text changes (the thread edited it). A footer says what the page
 * can reach.
 *
 * Whom the page acts for comes with the grant (usePageThread; docs/notes/page-ownership-gui.md):
 * its owning thread's bridge, named in the footer when that is not the tab's thread; for a
 * page no thread owns, the user's answer. A page not asked about yet that loads the bridge
 * gets the band (PageConsentBand) above it; the footer shows the answer and changes it
 * (Stop allowing, Allow Code Foundry). An answer reads the grant again (stores/pageAnswers.ts).
 */
export function HtmlPreview({ path, text, name, page: own, reloads = 0 }: { path: string; text: string; name: string; page?: { title: string } | undefined; /** The user's Refresh presses: each loads the page again, as written. */ reloads?: number }) {
  const grant = usePreviewGrant("", path);
  const page = usePageThread(path, own, grant.preview);
  const access = page.access;
  // A new key remounts the frame when the text changes (derived state, not an effect, so the first render loads once).
  const [prevText, setPrevText] = useState(text);
  const [version, setVersion] = useState(0);
  const [errors, setErrors] = useState<readonly PageError[]>([]);
  // The page (its resolved path) whose document asked for Code Foundry while not asked about yet: the band shows.
  const [askedBy, setAskedBy] = useState("");
  const [answering, setAnswering] = useState(false);
  const ownerName = useThreadsStore((s) => (page.actsFor ? s.byId[page.actsFor]?.name || page.actsFor : ""));
  if (text !== prevText) {
    setPrevText(text);
    setVersion(version + 1);
  }

  if (grant.loading)
    return (
      <div className="flex min-h-0 flex-1 flex-col" data-testid="file-html">
        <FileLoading />
      </div>
    );
  if (!grant.preview)
    return (
      <div className="flex min-h-0 flex-1 flex-col" data-testid="file-html">
        <FileEmptyState icon={TriangleAlert} heading="Cannot render the file" detail={grant.error} testId="file-html-error">
          <Button variant="outline" size="sm" onClick={grant.retry}>
            Retry
          </Button>
        </FileEmptyState>
      </div>
    );
  const consent = access?.consent;
  const asking = consent === "not-asked" && access !== null && askedBy === access.path;
  const answer = (allow: boolean) => {
    if (!access?.path || answering) return;
    setAnswering(true);
    void answerPage(access.path, allow).finally(() => {
      setAnswering(false);
    });
  };
  const scope = grant.preview.singleFile ? "loads this file only" : `loads files under ${tildify(grant.preview.scope)}`;
  // What the footer leads with: the answer that lets the page use Code Foundry, or the sandbox.
  const lead = consent === "allowed" ? "Can use Code Foundry" : page.actsFor ? "Can use Code Foundry for" : null;
  return (
    <div className="flex min-h-0 flex-1 flex-col" data-testid="file-html">
      {asking && <PageConsentBand busy={answering} onAnswer={answer} />}
      <HtmlFrame
        key={`${String(version)}:${String(reloads)}`}
        url={grant.preview.url}
        name={page.title || name}
        thread={page.thread}
        page={page.bridge}
        pagePath={access?.path || path}
        onAsk={() => {
          if (access?.consent === "not-asked") setAskedBy(access.path);
        }}
        className="min-h-0 flex-1"
        onPageErrors={setErrors}
        testId="file-html-frame"
      />
      <div className="flex shrink-0 items-center gap-1.5 border-t border-cf-divider px-3 py-1 text-caption-sm" data-testid="file-html-footer" data-consent={consent ?? undefined}>
        <ShieldCheck className={cn("size-3 shrink-0", consent === "allowed" && "text-cf-success-text", asking && "text-cf-warning-text")} aria-hidden />
        <span className="min-w-0 truncate">
          {lead ? (
            <>
              <span className="text-cf-text" data-testid="file-html-footer-state">
                {lead}
                {page.actsFor && (
                  <>
                    {" "}
                    <span className="font-medium" data-testid="file-html-footer-owner">
                      {ownerName}
                    </span>
                  </>
                )}
              </span>
              {` · scripts and network on · ${scope}`}
            </>
          ) : (
            `Sandboxed from Code Foundry · scripts and network on · ${scope}`
          )}
        </span>
        <div className="-my-1 ml-auto flex shrink-0 items-center gap-1.5">
          {(consent === "allowed" || consent === "refused") && (
            <Button
              variant="link"
              size="xs"
              className="h-5 px-0 text-caption-sm font-normal text-cf-text-muted underline hover:text-cf-text"
              disabled={answering}
              onClick={() => {
                answer(consent === "refused");
              }}
              data-testid="file-html-consent"
            >
              {consent === "allowed" ? "Stop allowing" : "Allow Code Foundry"}
            </Button>
          )}
          <PageErrors errors={errors} threadId={page.thread} page={page.title ? `${page.title} (${tildify(path)})` : tildify(path)} className="h-5" />
        </div>
      </div>
    </div>
  );
}
