import { useState } from "react";
import { MessageSquareText, TriangleAlert } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { askAboutPageErrors, pageErrorCount, type PageError } from "@/lib/pageErrors";
import { cn } from "@/lib/utils";
import { putInThreadComposer } from "@/stores/composerText";

/**
 * A page's errors on its strip (docs/notes/bridge-fix-c-gui.md): a count while the frame's
 * document was answered `invalid`, `unavailable`, `failed` or `timeout` (lib/pageErrors.ts),
 * and a popover with the latest few and one action, Ask Claude, which puts them in the
 * thread's composer (not sent) so the model that wrote the page can fix it. Nothing while
 * there are none; the frame's next load clears them.
 */
export function PageErrors({ errors, threadId, page, onAsk, className }: { errors: readonly PageError[]; threadId: string | null; page: string; onAsk?: () => void; className?: string }) {
  const [open, setOpen] = useState(false);
  if (errors.length === 0) return null;
  const n = pageErrorCount(errors);
  const label = `${String(n)} page ${n === 1 ? "error" : "errors"}`;
  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <Button type="button" variant="ghost" size="xs" className={cn("text-cf-error-text hover:text-cf-error-text", className)} aria-label={label} data-testid="page-errors">
          <TriangleAlert aria-hidden />
          {n}
        </Button>
      </PopoverTrigger>
      <PopoverContent align="end" className="w-80 p-0" data-testid="page-errors-popover">
        <div className="border-b border-cf-border px-3 py-2 text-label text-cf-text">Errors this page got</div>
        <ul className="flex max-h-64 flex-col overflow-y-auto py-1">
          {[...errors].reverse().map((e) => (
            <li key={`${e.call}\u0000${e.code}\u0000${e.message}`} className="px-3 py-1.5" data-testid="page-error">
              <div className="flex items-baseline gap-2">
                <span className="min-w-0 flex-1 truncate text-code text-cf-text">{e.call}</span>
                <span className="shrink-0 text-caption-sm text-cf-text-muted">
                  {e.count > 1 && `${String(e.count)}× · `}
                  {new Date(e.atMs).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", second: "2-digit" })}
                </span>
              </div>
              <div className="text-caption text-cf-text-muted">
                <span className="text-cf-error-text">{e.code}</span> {e.message}
              </div>
            </li>
          ))}
        </ul>
        {threadId !== null && (
          <div className="flex justify-end border-t border-cf-border px-2 py-1.5">
            <Button
              type="button"
              variant="outline"
              size="xs"
              data-testid="page-errors-ask"
              onClick={() => {
                setOpen(false);
                onAsk?.();
                putInThreadComposer(threadId, askAboutPageErrors(page, errors));
              }}
            >
              <MessageSquareText aria-hidden />
              Ask Claude
            </Button>
          </div>
        )}
      </PopoverContent>
    </Popover>
  );
}
