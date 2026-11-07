import { useEffect, useRef, useState, type ReactNode } from "react";
import { Download, LoaderCircle, TriangleAlert, X } from "lucide-react";
import {
  answerBrowserDialog,
  answerBrowserFiles,
  answerBrowserSelect,
  copyFromBrowser,
  revealBrowserDownload,
  type BrowserDialogView,
  type BrowserDownloadView,
  type BrowserFileChooserView,
  type BrowserSelectView,
  type BrowserStateView,
} from "@/api/browser";
import { pickFiles } from "@/api/app";
import { Button } from "@/components/ui/button";
import { Tip } from "@/components/ui/tooltip";
import { cn } from "@/lib/utils";
import { relaunch, setBrowserError } from "@/stores/browser";

/*
 * What Chrome cannot put in a frame, and what the surface must say out loud. Every word from a
 * page shows as text, and each of these names the origin that asked, inside the page's own
 * rectangle: they are the page speaking, never the app.
 */

function failed(surface: string): (err: unknown) => void {
  return (err) => {
    setBrowserError(surface, err);
  };
}

function Card({ children, label }: { children: ReactNode; label: string }) {
  return (
    <div className="absolute inset-0 z-10 grid place-items-center bg-black/30 p-4" role="dialog" aria-label={label} data-testid="browser-overlay">
      <div className="flex max-h-full w-full max-w-sm flex-col gap-3 overflow-auto rounded-lg border border-cf-divider bg-cf-surface p-4 shadow-md">{children}</div>
    </div>
  );
}

function PageDialog({ surface, d }: { surface: string; d: BrowserDialogView }) {
  const [text, setText] = useState(d.defaultPrompt);
  const answer = (accept: boolean) => {
    answerBrowserDialog(surface, d.id, accept, text).catch(failed(surface));
  };
  const leaving = d.kind === "beforeunload";
  return (
    <Card label="The page asks">
      <p className="text-caption text-cf-text-muted">{d.origin || "This page"} says</p>
      <p className="text-body whitespace-pre-wrap break-words" data-testid="browser-dialog-message">
        {leaving ? "Leave this page? Changes you made may not be saved." : d.message}
      </p>
      {d.kind === "prompt" && (
        <input
          autoFocus
          className="h-8 rounded-md bg-cf-surface-sunken px-2.5 text-body-sm outline-none focus-visible:ring-1 focus-visible:ring-ring"
          aria-label="Answer"
          value={text}
          onChange={(e) => {
            setText(e.target.value);
          }}
          onKeyDown={(e) => {
            if (e.key === "Enter") answer(true);
          }}
        />
      )}
      <div className="flex justify-end gap-2">
        {d.kind !== "alert" && (
          <Button
            variant="ghost"
            size="sm"
            onClick={() => {
              answer(false);
            }}
          >
            {leaving ? "Stay" : "Cancel"}
          </Button>
        )}
        <Button
          variant="outline"
          size="sm"
          onClick={() => {
            answer(true);
          }}
        >
          {leaving ? "Leave" : "OK"}
        </Button>
      </div>
    </Card>
  );
}

function PageFileChooser({ surface, f }: { surface: string; f: BrowserFileChooserView }) {
  const [noHost, setNoHost] = useState(false);
  const cancel = () => {
    answerBrowserFiles(surface, f.id, []).catch(failed(surface));
  };
  const choose = () => {
    pickFiles("")
      .then((paths) => {
        if (paths === null) {
          setNoHost(true);
          return;
        }
        answerBrowserFiles(surface, f.id, f.multiple ? paths : paths.slice(0, 1)).catch(failed(surface));
      })
      .catch(failed(surface));
  };
  return (
    <Card label="The page asks for files">
      <p className="text-body break-words">
        {f.origin || "This page"} asks for {f.multiple ? "files" : "a file"}. What you choose goes to the site.
      </p>
      {noHost && <p className="text-body-sm text-cf-text-muted">Choosing files needs the app's window.</p>}
      <div className="flex justify-end gap-2">
        <Button variant="ghost" size="sm" onClick={cancel}>
          Cancel
        </Button>
        <Button variant="outline" size="sm" onClick={choose} disabled={noHost}>
          Choose…
        </Button>
      </div>
    </Card>
  );
}

/** The list a page's <select> would open, placed under the control and kept inside the view. */
function PageSelect({ surface, s, scale }: { surface: string; s: BrowserSelectView; scale: { x: number; y: number } }) {
  const list = useRef<HTMLUListElement>(null);
  const pick = (i: number) => {
    answerBrowserSelect(surface, s.id, i).catch(failed(surface));
  };
  useEffect(() => {
    list.current?.focus();
    list.current?.querySelector('[aria-selected="true"]')?.scrollIntoView({ block: "nearest" });
  }, []);
  return (
    <div
      className="absolute inset-0 z-10"
      data-testid="browser-select-backdrop"
      onPointerDown={() => {
        pick(-1);
      }}
    >
      <ul
        ref={list}
        role="listbox"
        tabIndex={-1}
        aria-label="Options"
        data-testid="browser-select"
        className="absolute max-h-[60%] overflow-auto rounded-md border border-cf-divider bg-cf-surface py-1 shadow-md outline-none"
        style={{ left: Math.max(0, s.x * scale.x), top: s.y * scale.y, minWidth: Math.max(120, s.width * scale.x), maxWidth: "calc(100% - 8px)" }}
        onPointerDown={(e) => {
          e.stopPropagation();
        }}
        onKeyDown={(e) => {
          if (e.key === "Escape") {
            e.stopPropagation();
            pick(-1);
          }
        }}
      >
        {s.options.map((o, i) => (
          <li key={i} role="option" aria-selected={i === s.selected} aria-disabled={o.disabled}>
            <button
              type="button"
              disabled={o.disabled}
              className={cn("block w-full truncate px-3 py-1 text-left text-body-sm hover:bg-accent disabled:text-cf-text-muted disabled:hover:bg-transparent", i === s.selected && "font-medium")}
              onClick={() => {
                pick(i);
              }}
            >
              {o.label || " "}
            </button>
          </li>
        ))}
      </ul>
    </div>
  );
}

function Strip({ children, onClose, tone = "plain" }: { children: ReactNode; onClose?: () => void; tone?: "plain" | "warn" }) {
  return (
    <div className="flex items-center gap-2 rounded-md border border-cf-divider bg-cf-surface px-2.5 py-1.5 shadow-sm" data-testid="browser-strip">
      {tone === "warn" && <TriangleAlert className="size-3.5 shrink-0 text-cf-warning" />}
      <div className="flex min-w-0 flex-1 items-center gap-2 text-body-sm">{children}</div>
      {onClose && (
        <Tip label="Dismiss">
          <button type="button" aria-label="Dismiss" className="grid size-5 shrink-0 place-items-center rounded-sm text-cf-icon-muted hover:text-cf-text-primary" onClick={onClose}>
            <X className="size-3" />
          </button>
        </Tip>
      )}
    </div>
  );
}

function DownloadLine({ surface, d }: { surface: string; d: BrowserDownloadView }) {
  const done = d.state === "completed";
  return (
    <Strip>
      {d.state === "inProgress" ? <LoaderCircle className="size-3.5 shrink-0 animate-spin text-cf-icon-muted" /> : <Download className="size-3.5 shrink-0 text-cf-icon-muted" />}
      <span className="truncate">{d.name || "Download"}</span>
      {d.state === "canceled" && <span className="text-cf-text-muted">canceled</span>}
      {done && (
        <button
          type="button"
          className="ml-auto shrink-0 text-link"
          onClick={() => {
            revealBrowserDownload(surface, d.id).catch(failed(surface));
          }}
        >
          Show in Finder
        </button>
      )}
    </Strip>
  );
}

/** A page's own Copy button lands on Chrome's clipboard, which only this button can move on. */
function CopiedLine({ surface, onClose }: { surface: string; onClose: () => void }) {
  return (
    <Strip onClose={onClose}>
      <span className="truncate">The page copied text.</span>
      <button
        type="button"
        className="ml-auto shrink-0 text-link"
        onClick={() => {
          copyFromBrowser(surface).then(onClose).catch(failed(surface));
        }}
      >
        Copy to clipboard
      </button>
    </Strip>
  );
}

/** The whole view's state when there is no page to show. */
function PhaseCover({ surface, state }: { surface: string; state: BrowserStateView }) {
  if (state.phase === "starting") {
    return (
      <div className="absolute inset-0 z-10 grid place-items-center bg-cf-surface" data-testid="browser-starting">
        <p className="flex items-center gap-2 text-body-sm text-cf-text-muted">
          <LoaderCircle className="size-3.5 animate-spin" />
          Starting Chrome…
        </p>
      </div>
    );
  }
  if (state.phase === "ready") return null;
  return (
    <div className="absolute inset-0 z-10 grid place-items-center bg-cf-surface p-6" data-testid="browser-stopped">
      <div className="flex max-w-sm flex-col items-center gap-3 text-center">
        <p className="text-body break-words">{state.message}</p>
        {state.phase === "crashed" && (
          <Button
            variant="outline"
            size="sm"
            onClick={() => {
              relaunch(surface);
            }}
          >
            Relaunch Chrome
          </Button>
        )}
      </div>
    </div>
  );
}

/** Everything over the frames. */
export function BrowserOverlays({ surface, state, error, scale, onDismissError }: { surface: string; state: BrowserStateView; error: string; scale: { x: number; y: number }; onDismissError: () => void }) {
  const [seenCopied, setSeenCopied] = useState(state.copied);
  const finished = state.downloads.filter((d) => d.state !== "inProgress").length;
  const [cleared, setCleared] = useState(0);
  const downloads = cleared >= finished && state.downloads.every((d) => d.state !== "inProgress") ? [] : state.downloads.slice(-2);
  return (
    <>
      <PhaseCover surface={surface} state={state} />
      {state.dialog && <PageDialog key={state.dialog.id} surface={surface} d={state.dialog} />}
      {state.fileChooser && <PageFileChooser key={state.fileChooser.id} surface={surface} f={state.fileChooser} />}
      {state.select && <PageSelect key={state.select.id} surface={surface} s={state.select} scale={scale} />}
      <div className="pointer-events-none absolute inset-x-2 bottom-2 z-10 flex flex-col gap-1 [&>*]:pointer-events-auto">
        {error && (
          <Strip tone="warn" onClose={onDismissError}>
            <span className="min-w-0 break-words">{error}</span>
          </Strip>
        )}
        {state.notice && (
          <Strip tone="warn">
            <span className="min-w-0 break-words">{state.notice}</span>
          </Strip>
        )}
        {state.copied > seenCopied && (
          <CopiedLine
            surface={surface}
            onClose={() => {
              setSeenCopied(state.copied);
            }}
          />
        )}
        {downloads.map((d) => (
          <DownloadLine key={d.id} surface={surface} d={d} />
        ))}
        {downloads.length > 0 && finished > cleared && (
          <button
            type="button"
            className="self-end text-caption text-cf-text-muted hover:text-cf-text-primary"
            onClick={() => {
              setCleared(finished);
            }}
          >
            Clear
          </button>
        )}
      </div>
    </>
  );
}
