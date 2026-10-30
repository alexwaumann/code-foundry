import { memo, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { ArrowDown, Bookmark, ChevronRight, Code, FileCode, LoaderCircle, Maximize2, PanelRight, TriangleAlert, X, type LucideIcon } from "lucide-react";
import type { ThreadItemView } from "@/api/thread";
import { readFile } from "@/api/files";
import { CodeBody } from "@/components/files/CodeBody";
import { HtmlFrame } from "@/components/files/HtmlFrame";
import { PageErrors } from "@/components/files/PageErrors";
import { usePreviewGrant, type PreviewGrant } from "@/components/files/previewGrant";
import { useFileChanges, useTabRead } from "@/components/files/useTabRead";
import { Button } from "@/components/ui/button";
import { Tip } from "@/components/ui/tooltip";
import { SHELL_GAP } from "@/design/tokens";
import { frameHeight, inlinePage, type InlinePage } from "@/lib/inlinePage";
import type { PageError } from "@/lib/pageErrors";
import { tildify } from "@/lib/path";
import type { HtmlNode } from "@/lib/threadTimeline";
import { cn } from "@/lib/utils";
import { getTimeline } from "@/stores/cite";
import { openFileInPanel } from "@/stores/filePanel";
import {
  closePageModal,
  flashPage,
  openPageModal,
  PAGE_FLASH_MS,
  setPageModalSource,
  setRowExpanded,
  useRowExpanded,
  usePageFlash,
  usePageModal,
  usePageModalPath,
  useThreadItem,
  useThreadLoaded,
  type PageModalState,
} from "@/stores/thread";
import { useThreadsStore } from "@/stores/threads";
import { HoldTopContext, PaneOverlayContext, useThreadCtx } from "./context";

/**
 * A page the model showed inline (code-foundry view.inline; docs/notes/inline-html.md),
 * sketch variant A (docs/sketches/model-phase1): a work-log row "Showed <file> <dir>" and,
 * while open, a card: a strip (the path, then open in the side panel, expand, source and
 * save as artifact) over the page in the same sandboxed frame as the File tab's preview
 * (HtmlFrame). The page may ask for its height (`{ type: "cf:resize", height }`); the card
 * follows it up to 60% of the pane, else 420px (lib/inlinePage.ts). Open by default, and
 * the turn's fold never closes it: only its row does (docs/notes/thread-fold-5-text-and-html.md).
 * A closed card and a row scrolled away (the timeline is virtualized) hold no frame.
 *
 * One live instance per file (docs/notes/inline-page-shows.md): an earlier show of a page
 * shown again later is a one-line link row to the latest card (lib/threadTimeline
 * linkRepeatShows), and while the pane's modal (Expand) shows a file, that file's card keeps
 * its row and strip but drops its frame.
 */

/** The thread's scrolling timeline around an element (the pane the height cap is a share of). */
function timelineOf(el: Element | null): HTMLElement | null {
  return el?.closest<HTMLElement>('[data-testid="thread-timeline"]') ?? null;
}

/** The row's page, from its item; null until the item is there (or when it is not a page). */
function usePage(threadId: string, id: string): InlinePage | null {
  const item = useThreadItem(threadId, id);
  return useMemo(() => (item?.kind === "html" ? inlinePage(item) : null), [item]);
}

/** "Showed <b>name</b> dir": the row's label. */
function ShowedLabel({ page }: { page: InlinePage }) {
  return (
    <span className="lbl">
      Showed <b>{page.name}</b>
      {page.dir && (
        <>
          {" "}
          <span className="mono text-cf-text-muted">{page.dir}</span>
        </>
      )}
    </span>
  );
}

/** The work-log row and, while open, the card; an earlier show of a page shown again is a link row. */
export const HtmlRow = memo(function HtmlRow({ node }: { node: HtmlNode }) {
  const { threadId } = useThreadCtx();
  const page = usePage(threadId, node.id);
  // Open until the reader closes it with its row; the turn's fold never changes it. Leaving
  // the thread forgets the choice, so the card is open again on return.
  const key = `html:${node.id}`;
  const open = useRowExpanded(threadId, key, true);
  const flash = usePageFlash(threadId, node.id);
  if (!page) return null;
  if (node.later) return <EarlierShow threadId={threadId} page={page} id={node.id} later={node.later} />;
  return (
    <div data-testid="thread-html" data-item={node.id} data-open={open || undefined}>
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
        <ShowedLabel page={page} />
        {page.title && <span className="meta max-w-72 truncate">{page.title}</span>}
        <ChevronRight className="chev" aria-hidden />
      </button>
      {open && <HtmlCard threadId={threadId} id={node.id} page={page} flash={flash} />}
    </div>
  );
});

/**
 * An earlier show of a page the thread showed again later: one line, never a card. Clicking
 * it (or Enter/Space) brings the latest card into view and rings it a moment.
 */
function EarlierShow({ threadId, page, id, later }: { threadId: string; page: InlinePage; id: string; later: string }) {
  return (
    <div data-testid="thread-html" data-item={id} data-earlier>
      <button
        type="button"
        className="row"
        data-testid="thread-html-earlier"
        onClick={() => {
          showLatestCard(threadId, later);
        }}
      >
        <span className="ico">
          <FileCode aria-hidden />
        </span>
        <ShowedLabel page={page} />
        <span className="meta">
          <span className="inline-flex items-center gap-1 text-link">
            Shown again below
            <ArrowDown className="size-3.5" aria-hidden />
          </span>
        </span>
      </button>
    </div>
  );
}

/** Scrolls the thread's timeline to a page's card (its row key) and rings the card. */
function showLatestCard(threadId: string, rowKey: string): void {
  // Open it first: a card the reader closed with its row would have nothing to ring.
  setRowExpanded(threadId, `html:${rowKey}`, true);
  getTimeline(threadId)?.showRow(rowKey);
  flashPage(threadId, rowKey);
}

/** The page's frame, or its source; a page that cannot be rendered says why over its source. */
function CardBody({
  threadId,
  page,
  grant,
  source,
  height,
  version,
  covered,
  onResize,
  onPageErrors,
}: {
  threadId: string;
  page: InlinePage;
  grant: PreviewGrant;
  source: boolean;
  height: number;
  version: number;
  /** The pane's modal shows this file: its frame is the file's one, so here the surface only. */
  covered?: boolean;
  onResize?: (h: number) => void;
  onPageErrors?: (errors: readonly PageError[]) => void;
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
  if (covered) return <div className="bg-cf-surface" style={{ height }} data-testid="thread-html-covered" />;
  return <HtmlFrame key={version} url={grant.preview.url} name={page.title || page.name} thread={threadId} style={{ height }} onResize={onResize} onPageErrors={onPageErrors} testId="thread-html-frame" />;
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

/** The strip's actions: page errors, open in the side panel, expand (the card's, in a pane with a modal), source, save. */
function Actions({
  threadId,
  page,
  errors,
  onAsk,
  onExpand,
  source,
  onSource,
  failed,
}: {
  threadId: string;
  page: InlinePage;
  errors: readonly PageError[];
  onAsk?: () => void;
  onExpand?: () => void;
  source: boolean;
  onSource: () => void;
  failed: boolean;
}) {
  const project = useThreadsStore((s) => s.byId[threadId]?.projectId ?? "");
  const label = page.title ? `${page.title} (${tildify(page.abs)})` : tildify(page.abs);
  return (
    <>
      <PageErrors errors={errors} threadId={threadId} page={label} onAsk={onAsk} />
      <Action
        label="Open in side panel"
        icon={PanelRight}
        onClick={() => {
          openFileInPanel(`thread:${threadId}`, { project, base: page.baseDir, path: page.abs });
        }}
        testId="thread-html-panel"
      />
      {onExpand && <Action label="Expand" icon={Maximize2} onClick={onExpand} testId="thread-html-expand" />}
      <Action label={source ? "Show the page" : "Source"} icon={Code} pressed={source} disabled={failed} onClick={onSource} testId="thread-html-source-toggle" />
      <Action label="Artifacts come in a later release" icon={Bookmark} disabled testId="thread-html-save" />
    </>
  );
}

const NO_ERRORS: readonly PageError[] = [];

/** The card: strip and page; Expand shows the same in the pane's modal (PaneOverlay). */
function HtmlCard({ threadId, id, page, flash }: { threadId: string; id: string; page: InlinePage; flash: number }) {
  const grant = usePreviewGrant(page.baseDir, page.path);
  const scope = useContext(PaneOverlayContext);
  const covered = usePageModalPath(scope) === page.abs;
  const [source, setSource] = useState(false);
  const [asked, setAsked] = useState<number | null>(null);
  const [pane, setPane] = useState(() => window.innerHeight);
  const [version, setVersion] = useState(0);
  const [errors, setErrors] = useState<readonly PageError[]>([]);
  const ref = useRef<HTMLDivElement>(null);
  // The file was written (an edit, `cp` over it, `touch`): load it again (the grant holds).
  useFileChanges(page.abs, () => {
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
  // A link row pointed here: the card rings a moment (data-flash), as long as is left of it
  // when the card mounts (the timeline may bring it in a frame or two later).
  useEffect(() => {
    const el = ref.current;
    const left = flash + PAGE_FLASH_MS - Date.now();
    if (!el || flash === 0 || left <= 0) return;
    el.dataset.flash = "";
    const t = setTimeout(() => {
      delete el.dataset.flash;
    }, left);
    return () => {
      clearTimeout(t);
      delete el.dataset.flash;
    };
  }, [flash]);
  const height = frameHeight(asked, pane);
  // A page resizing under the pointer or with focus (a list it filters) keeps the card's top
  // where it is, not the timeline's bottom (docs/notes/page-library-fixes-b.md).
  const holdTop = useContext(HoldTopContext);
  const onResize = (h: number) => {
    const card = ref.current;
    const frame = card?.querySelector('[data-testid="thread-html-frame"]');
    if (card && frame && frameHeight(h, pane) !== height && (frame.matches(":hover") || document.activeElement === frame)) holdTop(card);
    setAsked(h);
  };
  return (
    <div
      ref={ref}
      className={cn(
        "mt-1 mb-2.5 ml-1 overflow-hidden rounded-lg border border-cf-border bg-cf-surface-raised transition-[box-shadow,border-color] duration-300 motion-reduce:transition-none",
        "data-flash:border-cf-focus data-flash:ring-[3px] data-flash:ring-cf-focus/50",
      )}
      data-testid="thread-html-card"
      data-page={page.abs}
    >
      <Strip page={page}>
        <Actions
          threadId={threadId}
          page={page}
          errors={covered ? NO_ERRORS : errors}
          source={source}
          onSource={() => {
            setSource((s) => !s);
          }}
          failed={!grant.loading && !grant.preview}
          onExpand={
            scope === null
              ? undefined
              : () => {
                  openPageModal(scope, threadId, id, source);
                }
          }
        />
      </Strip>
      <CardBody threadId={threadId} page={page} grant={grant} source={source} height={height} version={version} covered={covered} onResize={onResize} onPageErrors={setErrors} />
    </div>
  );
}

/**
 * A pane body's page modal (Expand): its scope for the cards inside (PaneOverlayContext),
 * and the modal itself over the body when the store has one open for the scope
 * (stores/thread.ts pageModals). It lives here, not in the card, so it outlives the card's
 * row (the timeline drops rows scrolled away) and is up again when the reader comes back
 * to the thread. Render it inside the pane's `relative` body, after what the modal covers.
 */
export function PaneOverlay({ scope, threadId, children }: { scope: string; threadId: string; children: ReactNode }) {
  const modal = usePageModal(scope);
  return (
    <PaneOverlayContext.Provider value={scope}>
      {children}
      {modal && <PageModal key={`${modal.thread}:${modal.id}`} scope={scope} threadId={threadId} modal={modal} />}
    </PaneOverlayContext.Provider>
  );
}

/** The open page: closes itself when its item leaves the log (once the log is there). */
function PageModal({ scope, threadId, modal }: { scope: string; threadId: string; modal: PageModalState }) {
  const item = useThreadItem(modal.thread, modal.id);
  const loaded = useThreadLoaded(modal.thread);
  const gone = modal.thread !== threadId || (loaded && item?.kind !== "html");
  useEffect(() => {
    if (gone) closePageModal(scope);
  }, [gone, scope]);
  if (gone || item?.kind !== "html") return null;
  return <PageModalBox scope={scope} threadId={threadId} item={item} source={modal.source} />;
}

function PageModalBox({ scope, threadId, item, source }: { scope: string; threadId: string; item: Extract<ThreadItemView, { kind: "html" }>; source: boolean }) {
  const page = useMemo(() => inlinePage(item), [item]);
  const grant = usePreviewGrant(page.baseDir, page.path);
  const [version, setVersion] = useState(0);
  const [errors, setErrors] = useState<readonly PageError[]>([]);
  useFileChanges(page.abs, () => {
    setVersion((v) => v + 1);
  });
  const close = () => {
    closePageModal(scope);
  };
  return (
    <Lightbox onClose={close} returnFocus={(pane) => pane?.querySelector<HTMLElement>(`[data-testid="thread-html-card"][data-page="${CSS.escape(page.abs)}"] [data-testid="thread-html-expand"]`) ?? null}>
      <Strip page={page} big>
        <Actions
          threadId={threadId}
          page={page}
          errors={errors}
          onAsk={close}
          source={source}
          onSource={() => {
            setPageModalSource(scope, !source);
          }}
          failed={!grant.loading && !grant.preview}
        />
        <Button type="button" variant="ghost" size="xs" className="ml-1 text-cf-text-muted" data-lightbox-close data-testid="thread-html-close" onClick={close}>
          <X aria-hidden />
          Close
        </Button>
      </Strip>
      {grant.preview && !source ? (
        <HtmlFrame key={version} url={grant.preview.url} name={page.title || page.name} thread={threadId} className="min-h-0 flex-1" onPageErrors={setErrors} onKey={close} testId="thread-html-lightbox-frame" />
      ) : (
        <div className="flex min-h-0 flex-1 flex-col overflow-auto">
          <CardBody threadId={threadId} page={page} grant={grant} source={source} height={2000} version={version} />
        </div>
      )}
    </Lightbox>
  );
}

/**
 * The page over the thread pane's body (the conversation and its composer; not its header,
 * the sidebar or the side panel, which stay usable), dimming it; Esc, Close or a click on
 * the dimmed edge closes it, and its frame goes with it. Opening moves focus to Close, not
 * the frame: keys inside the frame never reach the app (it is another document), so ⌘[ works
 * only while focus is outside it; Close stays one click or Tab away. Esc inside the frame
 * closes it too when the page loads /cf/bridge.js and nothing in the page consumed it: the
 * bridge forwards it as `cf:key` and the lightbox's frame (never the card's) hears it
 * (docs/notes/page-library-fixes-b.md). Closing hands focus back to the card's Expand
 * button (returnFocus, given the pane body). docs/notes/inline-html-2-fixes.md,
 * inline-page-shows.md.
 */
function Lightbox({ onClose, returnFocus, children }: { onClose: () => void; returnFocus: (pane: HTMLElement | null) => HTMLElement | null; children: ReactNode }) {
  const close = useRef(onClose);
  const back = useRef(returnFocus);
  const root = useRef<HTMLDivElement>(null);
  const box = useRef<HTMLDivElement>(null);
  useEffect(() => {
    close.current = onClose;
    back.current = returnFocus;
  });
  useEffect(() => {
    const pane = root.current?.parentElement ?? null;
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
      // Not "what had focus before": WebKit does not focus a button on click. Only while the
      // pane is still there (closing, not leaving the thread).
      if (pane?.isConnected) back.current(pane)?.focus();
    };
  }, []);
  return (
    <div
      ref={root}
      className="absolute inset-0 z-40 bg-black/55"
      data-testid="thread-html-lightbox"
      role="dialog"
      aria-label="Page"
      onMouseDown={(e) => {
        if (e.target === e.currentTarget) close.current();
      }}
    >
      <div
        ref={box}
        className="absolute flex flex-col overflow-hidden rounded-pane border border-cf-border-strong bg-cf-surface-raised shadow-2xl"
        style={{ inset: SHELL_GAP }}
        data-testid="thread-html-lightbox-box"
      >
        {children}
      </div>
    </div>
  );
}
