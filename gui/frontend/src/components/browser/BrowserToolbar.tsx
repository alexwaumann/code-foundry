import { useState } from "react";
import { ArrowLeft, ArrowRight, LoaderCircle, RotateCw, TriangleAlert, X } from "lucide-react";
import { navigateBrowser, type BrowserSecurityView, type BrowserStateView } from "@/api/browser";
import { Button } from "@/components/ui/button";
import { Tip } from "@/components/ui/tooltip";
import { addressParts, type AddressParts } from "@/lib/browserAddress";
import { cn } from "@/lib/utils";
import { goBack, goForward, reload, setBrowserError } from "@/stores/browser";

/** The page's address as the bar shows it. The blank page a surface starts on has none; a blank popup does, because an opener can write into it. */
function shownAddress(url: string, popup: boolean): string {
  return url === "about:blank" && !popup ? "" : url;
}

/** Says a page is not private, where nothing a page does can reach. */
function SecurityMark({ security }: { security: BrowserSecurityView }) {
  if (security === "") return null;
  const cert = security === "cert";
  return (
    <span className={cn("flex shrink-0 items-center gap-1 text-caption font-medium", cert ? "text-cf-error" : "text-cf-warning-text")} data-testid="browser-security">
      <TriangleAlert className="size-3.5" />
      {cert ? "Bad certificate" : "Not secure"}
    </span>
  );
}

/**
 * The address over the input while nobody edits it (lib/browserAddress.ts). The path shrinks away
 * first, then the host clips from the left, so its end, the registrable domain, stays in view.
 */
function ShownAddress({ parts }: { parts: AddressParts }) {
  return (
    <div className="pointer-events-none absolute inset-0 flex items-center overflow-hidden px-2.5 text-body-sm whitespace-pre" aria-hidden="true" data-testid="browser-address-shown">
      <span className="flex min-w-0 justify-end overflow-hidden">
        <span className="shrink-0 text-cf-text-muted">{parts.lead}</span>
        <span className="shrink-0 font-medium text-cf-text" data-testid="browser-address-site">
          {parts.site}
        </span>
      </span>
      <span className="min-w-0 shrink-[1000] truncate text-cf-text-muted">{parts.rest}</span>
    </div>
  );
}

/** Back, forward, reload and the address bar. */
export function BrowserToolbar({ surface, state, onLeave }: { surface: string; state: BrowserStateView; onLeave: () => void }) {
  // What was typed, on the page it was typed over: moving to another page drops it.
  const [typed, setTyped] = useState<{ text: string; over: string } | null>(null);
  const draft = typed?.over === state.url ? typed.text : null;
  const setDraft = (text: string | null) => {
    setTyped(text === null ? null : { text, over: state.url });
  };
  const address = draft ?? shownAddress(state.url, state.popup);
  const [editing, setEditing] = useState(false);
  const parts = editing || draft !== null ? null : addressParts(state.url, state.site);

  const go = () => {
    if (draft === null || draft.trim() === "") return;
    setBrowserError(surface, null);
    navigateBrowser(surface, draft)
      .then(() => {
        setDraft(null);
        onLeave();
      })
      .catch((err: unknown) => {
        setBrowserError(surface, err);
      });
  };

  const ready = state.phase === "ready";
  return (
    <div className="flex h-10 shrink-0 items-center gap-1 border-b border-cf-divider px-2" data-testid="browser-toolbar">
      <Tip label={state.popup ? "Back (closes this window at its first page)" : "Back"}>
        <Button
          variant="ghost"
          size="icon-xs"
          aria-label="Back"
          disabled={!ready || !state.canGoBack}
          onClick={() => {
            goBack(surface);
          }}
        >
          <ArrowLeft />
        </Button>
      </Tip>
      <Tip label="Forward">
        <Button
          variant="ghost"
          size="icon-xs"
          aria-label="Forward"
          disabled={!ready || !state.canGoForward}
          onClick={() => {
            goForward(surface);
          }}
        >
          <ArrowRight />
        </Button>
      </Tip>
      <Tip label="Reload">
        <Button
          variant="ghost"
          size="icon-xs"
          aria-label="Reload"
          disabled={!ready || state.url === ""}
          onClick={() => {
            reload(surface);
          }}
        >
          {state.loading ? <LoaderCircle className="animate-spin" /> : <RotateCw />}
        </Button>
      </Tip>
      <SecurityMark security={state.security} />
      <div className="relative min-w-0 flex-1">
        <input
          className={cn("h-7 w-full min-w-0 rounded-md bg-cf-surface-sunken px-2.5 text-body-sm text-cf-text-secondary outline-none focus:text-cf-text focus-visible:ring-1 focus-visible:ring-cf-focus/50", parts && "text-transparent")}
          aria-label="Address"
          placeholder="Enter an address"
          spellCheck={false}
          autoCapitalize="off"
          autoCorrect="off"
          value={address}
          data-testid="browser-address"
          onChange={(e) => {
            setDraft(e.target.value);
          }}
          onFocus={(e) => {
            setEditing(true);
            e.target.select();
          }}
          onBlur={() => {
            setEditing(false);
          }}
          onKeyDown={(e) => {
            if (e.key === "Enter") go();
            if (e.key === "Escape") {
              e.stopPropagation();
              setDraft(null);
              onLeave();
            }
          }}
        />
        {parts && <ShownAddress parts={parts} />}
        {draft !== null && (
          <Tip label="Discard what was typed">
            <button
              type="button"
              aria-label="Discard what was typed"
              className="absolute top-1.5 right-1.5 grid size-4 place-items-center rounded-sm text-cf-icon-muted hover:text-cf-text"
              onClick={() => {
                setDraft(null);
              }}
            >
              <X className="size-3" />
            </button>
          </Tip>
        )}
      </div>
    </div>
  );
}
