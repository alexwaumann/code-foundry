import { useEffect, useLayoutEffect, useRef, useState, type ReactNode, type RefObject } from "react";
import { Download, LoaderCircle, TriangleAlert, X } from "lucide-react";
import {
  answerBrowserDialog,
  answerBrowserDownload,
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
 *
 * A page puts these up when it likes, so none of them takes the keyboard by itself: a timed
 * prompt would otherwise pull the user's typing out of the composer and hand it to the page. An
 * overlay gets focus only if the user is already in this surface (surfaceFocus), or clicks it.
 */

/** Gives el the keyboard if it is already in el's surface, and leaves it alone everywhere else. */
function surfaceFocus(el: HTMLElement | null): void {
  if (el?.closest("[data-browser-surface]")?.contains(document.activeElement)) el.focus({ preventScroll: true });
}

/** An overlay that held the keyboard hands it back to the page as it goes, not to the body. */
function useReturnFocus(root: RefObject<HTMLElement | null>, onLeave: () => void): void {
  const leave = useRef(onLeave);
  useLayoutEffect(() => {
    leave.current = onLeave;
  });
  useLayoutEffect(() => {
    const el = root.current;
    return () => {
      if (el?.contains(document.activeElement)) leave.current();
    };
  }, [root]);
}

function failed(surface: string): (err: unknown) => void {
  return (err) => {
    setBrowserError(surface, err);
  };
}

/** Who is asking: the registrable domain, which a long host cannot push out of view, then the origin in full. */
function AskerOrigin({ site, origin }: { site: string; origin: string }) {
  if (!site || origin === `https://${site}`) return null;
  return <p className="text-caption break-all text-cf-text-muted">{origin}</p>;
}

function Card({ children, label, onLeave }: { children: ReactNode; label: string; onLeave: () => void }) {
  const root = useRef<HTMLDivElement>(null);
  useReturnFocus(root, onLeave);
  return (
    <div ref={root} className="absolute inset-0 z-10 grid place-items-center bg-cf-scrim p-4" role="dialog" aria-label={label} data-testid="browser-overlay">
      <div className="flex max-h-full w-full max-w-sm flex-col gap-3 overflow-auto rounded-lg border border-cf-divider bg-cf-surface p-4 shadow-md">{children}</div>
    </div>
  );
}

function PageDialog({ surface, d, onLeave }: { surface: string; d: BrowserDialogView; onLeave: () => void }) {
  const [text, setText] = useState(d.defaultPrompt);
  const input = useRef<HTMLInputElement>(null);
  useEffect(() => {
    surfaceFocus(input.current);
  }, []);
  const answer = (accept: boolean) => {
    answerBrowserDialog(surface, d.id, accept, text).catch(failed(surface));
  };
  const leaving = d.kind === "beforeunload";
  return (
    <Card label="The page asks" onLeave={onLeave}>
      <p className="text-caption break-words text-cf-text-muted">
        <span className="font-medium text-cf-text">{d.site || d.origin || "This page"}</span> says
      </p>
      <AskerOrigin site={d.site} origin={d.origin} />
      <p className="text-body whitespace-pre-wrap break-words" data-testid="browser-dialog-message">
        {leaving ? "Leave this page? Changes you made may not be saved." : d.message}
      </p>
      {d.kind === "prompt" && (
        <input
          ref={input}
          className="h-8 rounded-md bg-cf-surface-sunken px-2.5 text-body-sm outline-none focus-visible:ring-1 focus-visible:ring-cf-focus/50"
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

function PageFileChooser({ surface, f, onLeave }: { surface: string; f: BrowserFileChooserView; onLeave: () => void }) {
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
    <Card label="The page asks for files" onLeave={onLeave}>
      <p className="text-body break-words">
        <span className="font-medium">{f.site || f.origin || "This page"}</span> asks for {f.multiple ? "files" : "a file"}. What you choose goes to the site.
      </p>
      <AskerOrigin site={f.site} origin={f.origin} />
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
function PageSelect({ surface, s, scale, onLeave }: { surface: string; s: BrowserSelectView; scale: { x: number; y: number }; onLeave: () => void }) {
  const list = useRef<HTMLUListElement>(null);
  useReturnFocus(list, onLeave);
  const pick = (i: number) => {
    answerBrowserSelect(surface, s.id, i).catch(failed(surface));
  };
  useEffect(() => {
    surfaceFocus(list.current);
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
              className={cn("block w-full truncate px-3 py-1 text-left text-body-sm hover:bg-cf-control-hover disabled:text-cf-text-muted disabled:hover:bg-transparent", i === s.selected && "font-medium")}
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
          <button type="button" aria-label="Dismiss" className="grid size-5 shrink-0 place-items-center rounded-sm text-cf-icon-muted hover:text-cf-text" onClick={onClose}>
            <X className="size-3" />
          </button>
        </Tip>
      )}
    </div>
  );
}

function DownloadLine({ surface, d }: { surface: string; d: BrowserDownloadView }) {
  const answer = (allow: boolean) => {
    answerBrowserDownload(surface, d.id, allow).catch(failed(surface));
  };
  if (d.state === "asking") {
    return (
      <Strip tone="warn">
        <span className="min-w-0 flex-1 break-words">
          <span className="font-medium">{d.site || "This page"}</span> wants to download {d.name || "a file"}
        </span>
        <button
          type="button"
          className="shrink-0 text-link"
          onClick={() => {
            answer(false);
          }}
        >
          Block
        </button>
        <button
          type="button"
          className="shrink-0 text-link"
          onClick={() => {
            answer(true);
          }}
        >
          Allow
        </button>
      </Strip>
    );
  }
  const done = d.state === "completed";
  return (
    <Strip>
      {d.state === "inProgress" ? <LoaderCircle className="size-3.5 shrink-0 animate-spin text-cf-icon-muted" /> : <Download className="size-3.5 shrink-0 text-cf-icon-muted" />}
      <span className="truncate">{d.name || "Download"}</span>
      {(d.state === "canceled" || d.state === "blocked") && <span className="shrink-0 text-cf-text-muted">{d.state}</span>}
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

/** Every download a page made: the list is what tells the user a page tried. */
function Downloads({ surface, state }: { surface: string; state: BrowserStateView }) {
  const [cleared, setCleared] = useState<ReadonlySet<string>>(new Set());
  const [clearedBlocked, setClearedBlocked] = useState(0);
  const shown = state.downloads.filter((d) => !cleared.has(d.id));
  const over = (d: BrowserDownloadView) => d.state !== "inProgress" && d.state !== "asking";
  const blocked = state.downloadsBlocked - clearedBlocked;
  if (shown.length === 0 && blocked <= 0) return null;
  return (
    <>
      <div className="flex max-h-48 flex-col gap-1 overflow-y-auto" data-testid="browser-downloads">
        {shown.map((d) => (
          <DownloadLine key={d.id} surface={surface} d={d} />
        ))}
        {blocked > 0 && (
          <Strip>
            <span className="truncate text-cf-text-muted">
              {blocked} more {blocked === 1 ? "download" : "downloads"} blocked
            </span>
          </Strip>
        )}
      </div>
      {(blocked > 0 || shown.some(over)) && (
        <button
          type="button"
          className="self-end text-caption text-cf-text-muted hover:text-cf-text"
          onClick={() => {
            setCleared(new Set([...cleared, ...state.downloads.filter(over).map((d) => d.id)]));
            setClearedBlocked(state.downloadsBlocked);
          }}
        >
          Clear
        </button>
      )}
    </>
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
          copyFromBrowser(surface, true).then(onClose).catch(failed(surface));
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
export function BrowserOverlays({
  surface,
  state,
  error,
  offline = false,
  scale,
  onLeave,
  onDismissError,
}: {
  surface: string;
  state: BrowserStateView;
  error: string;
  offline?: boolean;
  scale: { x: number; y: number };
  /** Gives the keyboard back to the page. */
  onLeave: () => void;
  onDismissError: () => void;
}) {
  const [seenCopied, setSeenCopied] = useState(state.copied);
  return (
    <>
      <PhaseCover surface={surface} state={state} />
      {state.dialog && <PageDialog key={state.dialog.id} surface={surface} d={state.dialog} onLeave={onLeave} />}
      {state.fileChooser && <PageFileChooser key={state.fileChooser.id} surface={surface} f={state.fileChooser} onLeave={onLeave} />}
      {state.select && <PageSelect key={state.select.id} surface={surface} s={state.select} scale={scale} onLeave={onLeave} />}
      <div className="pointer-events-none absolute inset-x-2 bottom-2 z-10 flex flex-col gap-1 [&>*]:pointer-events-auto">
        {offline && (
          <Strip tone="warn">
            <span className="min-w-0 break-words">Lost the connection to the daemon. Reconnecting…</span>
          </Strip>
        )}
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
        <Downloads surface={surface} state={state} />
      </div>
    </>
  );
}
