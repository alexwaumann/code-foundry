import { useEffect, useState } from "react";
import { ShieldCheck, TriangleAlert } from "lucide-react";
import { previewFile, type FilePreview } from "@/api/files";
import { errorMessage, isAbort } from "@/api/stream";
import { Button } from "@/components/ui/button";
import { tildify } from "@/lib/path";
import { FileEmptyState, FileLoading } from "./states";

/**
 * The frame's sandbox: scripts, forms, dialogs, downloads and popups (a target=_blank link
 * opens in the browser), but never `allow-same-origin`, so the page has an opaque origin
 * and cannot reach Code Foundry's window or the daemon's authenticated routes, and never
 * `allow-top-navigation`, so a link cannot replace the app.
 */
export const HTML_PREVIEW_SANDBOX = "allow-scripts allow-forms allow-popups allow-popups-to-escape-sandbox allow-modals allow-downloads";

/**
 * An HTML file rendered live: the daemon serves it, and everything under its scope (its
 * checkout, else its directory; the file alone when that directory is home or another
 * folder too broad to hand a page), at a granted URL (FilesystemService.PreviewFile), so its
 * scripts run and its relative links, stylesheets, scripts and images resolve; the network
 * is open for CDNs. A srcdoc frame could do none of that: its links resolved against the
 * app's own URL and navigated the frame into the app's blank shell (docs/notes/
 * html-preview-interactive.md). The frame reloads when the file's text changes (the thread
 * edited it). A white canvas, as in a browser; a footer says what the page can reach.
 */
export function HtmlPreview({ path, text, name }: { path: string; text: string; name: string }) {
  const [state, setState] = useState<{ path: string; preview: FilePreview | null; error: string | null }>({ path: "", preview: null, error: null });
  const [attempt, setAttempt] = useState(0);
  useEffect(() => {
    const c = new AbortController();
    previewFile("", path, undefined, c.signal).then(
      (preview) => {
        if (!c.signal.aborted) setState({ path, preview, error: null });
      },
      (err: unknown) => {
        if (!isAbort(err) && !c.signal.aborted) setState({ path, preview: null, error: errorMessage(err) });
      },
    );
    return () => {
      c.abort();
    };
  }, [path, attempt]);
  // A new key remounts the frame when the text changes (derived state, not an effect, so the first render loads once).
  const [prevText, setPrevText] = useState(text);
  const [version, setVersion] = useState(0);
  if (text !== prevText) {
    setPrevText(text);
    setVersion(version + 1);
  }

  const current = state.path === path ? state : null;
  if (!current)
    return (
      <div className="flex min-h-0 flex-1 flex-col" data-testid="file-html">
        <FileLoading />
      </div>
    );
  if (!current.preview)
    return (
      <div className="flex min-h-0 flex-1 flex-col" data-testid="file-html">
        <FileEmptyState icon={TriangleAlert} heading="Cannot render the file" detail={current.error} testId="file-html-error">
          <Button
            variant="outline"
            size="sm"
            onClick={() => {
              setAttempt((n) => n + 1);
            }}
          >
            Retry
          </Button>
        </FileEmptyState>
      </div>
    );
  return (
    <div className="flex min-h-0 flex-1 flex-col" data-testid="file-html">
      <iframe
        key={version}
        aria-label={`${name} (rendered)`}
        src={current.preview.url}
        sandbox={HTML_PREVIEW_SANDBOX}
        referrerPolicy="no-referrer"
        className="min-h-0 w-full flex-1 border-0 bg-white"
        data-testid="file-html-frame"
      />
      <div className="flex shrink-0 items-center gap-1.5 border-t border-pane-border px-3 py-1 text-caption-sm" data-testid="file-html-footer">
        <ShieldCheck className="size-3 shrink-0" aria-hidden />
        <span className="min-w-0 truncate">
          Sandboxed from Code Foundry · scripts and network on · {current.preview.singleFile ? "loads this file only" : `loads files under ${tildify(current.preview.scope)}`}
        </span>
      </div>
    </div>
  );
}
