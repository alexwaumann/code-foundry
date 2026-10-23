import { memo, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { Bookmark, ChevronRight, Code, FileCode, LoaderCircle, Maximize2, PanelRight, TriangleAlert, X, type LucideIcon } from "lucide-react";
import { readFile } from "@/api/files";
import { CodeBody } from "@/components/files/CodeBody";
import { HtmlFrame } from "@/components/files/HtmlFrame";
import { usePreviewGrant, type PreviewGrant } from "@/components/files/previewGrant";
import { useTabRead, useToolEdits } from "@/components/files/useTabRead";
import { Button } from "@/components/ui/button";
import { Tip } from "@/components/ui/tooltip";
import { TITLE_BAND_HEIGHT } from "@/components/window/titleBand";
import { SHELL_GAP } from "@/design/tokens";
import { frameHeight, inlinePage, type InlinePage } from "@/lib/inlinePage";
import { tildify } from "@/lib/path";
import type { WorkNode } from "@/lib/threadTimeline";
import { cn } from "@/lib/utils";
import { openFileInPanel } from "@/stores/filePanel";
import { setRowExpanded, useRowExpanded, useThreadItem } from "@/stores/thread";
import { useThreadsStore } from "@/stores/threads";
import { useThreadCtx } from "./context";

/**
 * A page the model showed inline (code-foundry view.inline; docs/notes/inline-html.md),
 * sketch variant A (docs/sketches/model-phase1): a work-log row "Showed <file> <dir>" and,
 * while open, a card: a strip (the path, then open in the side panel, expand, source and
 * save as artifact) over the page in the same sandboxed frame as the File tab's preview
 * (HtmlFrame). The page may ask for its height (`{ type: "cf:resize", height }`); the card
 * follows it up to 60% of the pane, else 420px (lib/inlinePage.ts). Open by default, and
 * the turn's fold never closes it: only its row does (docs/notes/inline-html-3-never-folds.md).
 * A closed card and a row scrolled away (the timeline is virtualized) hold no frame.
 */

/** The thread's scrolling timeline around an element (the pane the height cap is a share of). */
function timelineOf(el: Element | null): HTMLElement | null {
  return el?.closest<HTMLElement>('[data-testid="thread-timeline"]') ?? null;
}

/** The work-log row and, while open, the card. */
export const HtmlRow = memo(function HtmlRow({ node }: { node: Extract<WorkNode, { type: "html" }> }) {
  const { threadId } = useThreadCtx();
  const item = useThreadItem(threadId, node.id);
  // Open until the reader closes it with its row; the turn's fold never changes it. Leaving
  // the thread forgets the choice, so the card is open again on return.
  const key = `html:${node.id}`;
  const open = useRowExpanded(threadId, key, true);
  const page = useMemo(() => (item?.kind === "html" ? inlinePage(item) : null), [item]);
  if (!page) return null;
  return (
    <div data-testid="thread-html" data-open={open || undefined}>
      <button
        type="button"
        className="row"
        aria-expanded={open}
        data-testid="thread-html-row"
        onClick={() => {
          setRowExpanded(threadId, key, !open);
        }}
      >
        <span className="ico">
          <FileCode aria-hidden />
        </span>
        <span className="lbl">
          Showed <b>{page.name}</b>
          {page.dir && (
            <>
              {" "}
              <span className="mono text-cf-text-muted">{page.dir}</span>
            </>
          )}
        </span>
        {page.title && <span className="meta max-w-72 truncate">{page.title}</span>}
        <ChevronRight className="chev" aria-hidden />
      </button>
      {open && <HtmlCard threadId={threadId} page={page} />}
    </div>
  );
});

/** The page's frame, or its source; a page that cannot be rendered says why over its source. */
function CardBody({
  page,
  grant,
  source,
  height,
  version,
  onResize,
}: {
  page: InlinePage;
  grant: PreviewGrant;
  source: boolean;
  height: number;
  version: number;
  onResize?: (h: number) => void;
}) {
  if (grant.loading)
    return (
      <div className="flex items-center justify-center text-cf-text-muted" style={{ height }} data-testid="thread-html-loading">
        <LoaderCircle className="size-4 animate-spin" aria-label="Loading" />
      </div>
    );
  if (!grant.preview)
    return (
      <>
        <div className="flex items-start gap-2 border-b border-cf-border bg-cf-warning-surface px-3 py-2 text-caption t-amber" data-testid="thread-html-failed" role="status">
          <TriangleAlert className="mt-px size-3.5 shrink-0" aria-hidden />
          <span className="shrink-0">Could not render this page.</span>
          {grant.error && <span className="min-w-0 text-cf-text-muted">{grant.error}</span>}
        </div>
        <SourceView page={page} height={Math.min(height, 240)} version={version} />
      </>
    );
  if (source) return <SourceView page={page} height={height} version={version} />;
  return <HtmlFrame key={version} url={grant.preview.url} name={page.title || page.name} style={{ height }} onResize={onResize} testId="thread-html-frame" />;
}

/** The file read-only as code (the File tab's code view), or why it cannot be read. */
function SourceView({ page, height, version }: { page: InlinePage; height: number; version: number }) {
  const read = useTabRead(`${page.abs}\u0000${String(version)}`, (signal) => readFile(page.baseDir, page.path, undefined, signal));
  const text = read.data?.text ?? null;
  const lines = useMemo(() => (text === null ? 0 : text.split("\n").length), [text]);
  let body: ReactNode;
  if (read.data === null && read.error === null) body = <LoaderCircle className="m-3 size-4 animate-spin text-cf-text-muted" aria-label="Loading" />;
  else if (text === null) {
    const why = read.error ?? (read.data?.notFound ? `no file at ${tildify(page.abs)}` : "it is not a text file");
    body = <p className="px-3 py-2 text-caption text-cf-text-muted">The source cannot be read either: {why}</p>;
  } else body = <CodeBody name={page.name} text={text} lines={lines} />;
  return (
    <div className="flex min-h-0 flex-col" style={text === null ? undefined : { height }} data-testid="thread-html-source">
      {body}
    </div>
  );
}

/** An edge action of the strip, with its tooltip. A disabled one keeps its tooltip (aria-disabled). */
function Action({ label, icon: Icon, onClick, pressed, disabled, testId }: { label: string; icon: LucideIcon; onClick?: () => void; pressed?: boolean; disabled?: boolean; testId: string }) {
  return (
    <Tip label={label}>
      <Button
        type="button"
        variant="ghost"
        size="icon-xs"
        className={cn("text-cf-text-muted", pressed && "bg-cf-control-hover text-cf-text", disabled && "cursor-default opacity-50 hover:bg-transparent hover:text-cf-text-muted")}
        aria-label={label}
        aria-pressed={pressed}
        aria-disabled={disabled || undefined}
        data-testid={testId}
        onClick={disabled ? undefined : onClick}
      >
        <Icon aria-hidden />
      </Button>
    </Tip>
  );
}

/** The strip over the page: its path (the directory muted), then the actions. */
function Strip({ page, children, big }: { page: InlinePage; children: ReactNode; big?: boolean }) {
  return (
    <div className={cn("flex shrink-0 items-center gap-1.5 border-b border-cf-border bg-cf-surface-sunken pr-1 text-cf-text-muted dark:bg-cf-text/4", big ? "h-10 pl-3.5" : "h-8 pl-2.5")} data-testid="thread-html-strip">
      <FileCode className="size-3.5 shrink-0" aria-hidden />
      <span className="mono min-w-0 flex-1 truncate text-caption" data-testid="thread-html-path">
        {page.dir && <span>{page.dir}/</span>}
        <span className="text-cf-text/85">{page.name}</span>
      </span>
      {children}
    </div>
  );
}

/** The card: strip and page; Expand shows the same over the pane. */
function HtmlCard({ threadId, page }: { threadId: string; page: InlinePage }) {
  const grant = usePreviewGrant(page.baseDir, page.path);
  const project = useThreadsStore((s) => s.byId[threadId]?.projectId ?? "");
  const [source, setSource] = useState(false);
  /** Expanded: the lightbox shows. */
  const [lightbox, setLightbox] = useState(false);
  const [asked, setAsked] = useState<number | null>(null);
  const [pane, setPane] = useState(() => window.innerHeight);
  const [version, setVersion] = useState(0);
  const ref = useRef<HTMLDivElement>(null);
  // The thread edited the file: load it again (the grant holds).
  useToolEdits(page.abs, () => {
    setVersion((v) => v + 1);
  });
  useEffect(() => {
    const el = timelineOf(ref.current);
    if (!el) return;
    const ro = new ResizeObserver(() => {
      setPane(el.clientHeight);
    });
    ro.observe(el);
    setPane(el.clientHeight);
    return () => {
      ro.disconnect();
    };
  }, []);
  const height = frameHeight(asked, pane);
  const failed = !grant.loading && !grant.preview;
  const close = () => {
    setLightbox(false);
  };
  const actions = (expanded: boolean) => (
    <>
      <Action
        label="Open in side panel"
        icon={PanelRight}
        onClick={() => {
          openFileInPanel(`thread:${threadId}`, { project, base: page.baseDir, path: page.abs });
        }}
        testId="thread-html-panel"
      />
      {!expanded && (
        <Action
          label="Expand"
          icon={Maximize2}
          onClick={() => {
            setLightbox(true);
          }}
          testId="thread-html-expand"
        />
      )}
      <Action
        label={source ? "Show the page" : "Source"}
        icon={Code}
        pressed={source}
        disabled={failed}
        onClick={() => {
          setSource((s) => !s);
        }}
        testId="thread-html-source-toggle"
      />
      <Action label="Artifacts come in a later release" icon={Bookmark} disabled testId="thread-html-save" />
    </>
  );
  return (
    <div ref={ref} className="mt-1 mb-2.5 ml-1 overflow-hidden rounded-lg border border-cf-border bg-cf-surface-raised" data-testid="thread-html-card">
      <Strip page={page}>{actions(false)}</Strip>
      <CardBody page={page} grant={grant} source={source} height={height} version={version} onResize={setAsked} />
      {lightbox && (
        <Lightbox onClose={close} returnFocus={() => ref.current?.querySelector<HTMLElement>('[data-testid="thread-html-expand"]') ?? null}>
          <Strip page={page} big>
            {actions(true)}
            <Button type="button" variant="ghost" size="xs" className="ml-1 text-cf-text-muted" data-lightbox-close data-testid="thread-html-close" onClick={close}>
              <X aria-hidden />
              Close
            </Button>
          </Strip>
          {grant.preview && !source ? (
            <HtmlFrame key={version} url={grant.preview.url} name={page.title || page.name} className="min-h-0 flex-1" testId="thread-html-lightbox-frame" />
          ) : (
            <div className="flex min-h-0 flex-1 flex-col overflow-auto">
              <CardBody page={page} grant={grant} source={source} height={Math.max(height, 2000)} version={version} />
            </div>
          )}
        </Lightbox>
      )}
    </div>
  );
}

/**
 * The page over the whole window (sidebar, thread and side panel), below the title band so
 * the traffic lights stay clear, dimming the rest; Esc, Close or a click on the dimmed edge
 * closes it, and its frame goes with it. Opening moves focus to Close, not the frame: keys
 * inside the frame never reach the app (it is another document), so Esc and ⌘[ work only
 * while focus is outside it; Close stays one click or Tab away. Closing hands focus back to
 * the card's Expand button (returnFocus). docs/notes/inline-html-2-fixes.md.
 */
function Lightbox({ onClose, returnFocus, children }: { onClose: () => void; returnFocus: () => HTMLElement | null; children: ReactNode }) {
  const close = useRef(onClose);
  const back = useRef(returnFocus);
  const box = useRef<HTMLDivElement>(null);
  useEffect(() => {
    close.current = onClose;
    back.current = returnFocus;
  });
  useEffect(() => {
    box.current?.querySelector<HTMLElement>("[data-lightbox-close]")?.focus();
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "Escape") return;
      e.preventDefault();
      e.stopPropagation();
      close.current();
    };
    document.addEventListener("keydown", onKey, true);
    return () => {
      document.removeEventListener("keydown", onKey, true);
      // Not "what had focus before": WebKit does not focus a button on click.
      back.current()?.focus();
    };
  }, []);
  return createPortal(
    <div
      // cf-thread: the strip's thread-scoped styles (.mono, tones) hold outside the pane too.
      className="cf-thread fixed inset-0 z-40 bg-black/55"
      data-testid="thread-html-lightbox"
      role="dialog"
      aria-modal="true"
      aria-label="Page"
      onMouseDown={(e) => {
        if (e.target === e.currentTarget) close.current();
      }}
    >
      <div
        ref={box}
        className="absolute flex flex-col overflow-hidden rounded-pane border border-cf-border-strong bg-cf-surface-raised shadow-2xl"
        style={{ top: TITLE_BAND_HEIGHT, left: SHELL_GAP, right: SHELL_GAP, bottom: SHELL_GAP }}
        data-testid="thread-html-lightbox-box"
      >
        {children}
      </div>
    </div>,
    document.body,
  );
}
