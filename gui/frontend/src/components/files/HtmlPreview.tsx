import { useMemo } from "react";
import { ShieldCheck } from "lucide-react";
import { sandboxedDocument } from "./fileKind";

/**
 * An HTML file rendered in a sandboxed frame: `sandbox=""` (no scripts, no same origin, no
 * forms, no navigation), srcdoc, no referrer, and HTML_PREVIEW_CSP (fileKind.ts). A white
 * canvas, as in a browser. A footer says what does not load.
 */
export function HtmlPreview({ text, name }: { text: string; name: string }) {
  const doc = useMemo(() => sandboxedDocument(text), [text]);
  return (
    <div className="flex min-h-0 flex-1 flex-col" data-testid="file-html">
      <iframe aria-label={`${name} (rendered)`} sandbox="" srcDoc={doc} referrerPolicy="no-referrer" className="min-h-0 w-full flex-1 border-0 bg-white" data-testid="file-html-frame" />
      <div className="flex shrink-0 items-center gap-1.5 border-t border-pane-border px-3 py-1 text-caption-sm" data-testid="file-html-footer">
        <ShieldCheck className="size-3 shrink-0" aria-hidden />
        <span className="min-w-0 truncate">Rendered in a sandbox: no scripts, no network, local assets not loaded</span>
      </div>
    </div>
  );
}
