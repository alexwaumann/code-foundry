import { useState } from "react";
import { ShieldCheck, TriangleAlert } from "lucide-react";
import { Button } from "@/components/ui/button";
import { tildify } from "@/lib/path";
import { HtmlFrame } from "./HtmlFrame";
import { usePreviewGrant } from "./previewGrant";
import { usePageThread } from "./usePageThread";
import { FileEmptyState, FileLoading } from "./states";

export { HTML_PREVIEW_SANDBOX } from "./HtmlFrame";

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
 */
export function HtmlPreview({ path, text, name }: { path: string; text: string; name: string }) {
  const grant = usePreviewGrant("", path);
  // A page its panel's thread showed has that thread's bridge; any other file none.
  const thread = usePageThread(path);
  // A new key remounts the frame when the text changes (derived state, not an effect, so the first render loads once).
  const [prevText, setPrevText] = useState(text);
  const [version, setVersion] = useState(0);
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
  return (
    <div className="flex min-h-0 flex-1 flex-col" data-testid="file-html">
      <HtmlFrame key={version} url={grant.preview.url} name={name} thread={thread} className="min-h-0 flex-1" testId="file-html-frame" />
      <div className="flex shrink-0 items-center gap-1.5 border-t border-cf-divider px-3 py-1 text-caption-sm" data-testid="file-html-footer">
        <ShieldCheck className="size-3 shrink-0" aria-hidden />
        <span className="min-w-0 truncate">
          Sandboxed from Code Foundry · scripts and network on · {grant.preview.singleFile ? "loads this file only" : `loads files under ${tildify(grant.preview.scope)}`}
        </span>
      </div>
    </div>
  );
}
