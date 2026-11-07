import { useState } from "react";
import { ArrowLeft, ArrowRight, LoaderCircle, RotateCw, X } from "lucide-react";
import { navigateBrowser, type BrowserStateView } from "@/api/browser";
import { Button } from "@/components/ui/button";
import { Tip } from "@/components/ui/tooltip";
import { goBack, goForward, reload, setBrowserError } from "@/stores/browser";

/** The page's address as the bar shows it: nothing for the blank page a surface starts on. */
function shownAddress(url: string): string {
  return url === "about:blank" ? "" : url;
}

/** Back, forward, reload and the address bar. */
export function BrowserToolbar({ surface, state, onLeave }: { surface: string; state: BrowserStateView; onLeave: () => void }) {
  // What was typed, on the page it was typed over: moving to another page drops it.
  const [typed, setTyped] = useState<{ text: string; over: string } | null>(null);
  const draft = typed?.over === state.url ? typed.text : null;
  const setDraft = (text: string | null) => {
    setTyped(text === null ? null : { text, over: state.url });
  };
  const address = draft ?? shownAddress(state.url);

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
      <div className="relative min-w-0 flex-1">
        <input
          className="h-7 w-full min-w-0 rounded-md bg-cf-surface-sunken px-2.5 text-body-sm text-cf-text-secondary outline-none focus:text-cf-text-primary focus-visible:ring-1 focus-visible:ring-ring"
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
            e.target.select();
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
        {draft !== null && (
          <Tip label="Discard what was typed">
            <button
              type="button"
              aria-label="Discard what was typed"
              className="absolute top-1.5 right-1.5 grid size-4 place-items-center rounded-sm text-cf-icon-muted hover:text-cf-text-primary"
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
