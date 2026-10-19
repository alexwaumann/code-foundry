import { useEffect, useEffectEvent, useRef, useState, type RefObject } from "react";
import { loadPdf, type PdfDocument } from "@/lib/pdf";
import { zoomFactor } from "@/lib/zoom";
import { cn } from "@/lib/utils";

/** The most device pixels per CSS px a page is drawn at: sharp on a Retina screen, not more. */
const MAX_PIXEL_RATIO = 2;

/**
 * How far from the view (in viewports of the scroller) a drawn page keeps its canvas.
 * Farther, the canvas is released (sized to nothing) and the placeholder comes back, so a
 * long PDF holds only the pages around the view; it is drawn again when it comes near.
 */
const KEEP_MARGIN = "300% 0px";

/** How near the view a page is drawn. */
const DRAW_MARGIN = "50% 0px";

/**
 * One page: a placeholder of the page's shape until it scrolls near the view, then a
 * canvas pdf.js draws at the column's width (in device pixels, at most MAX_PIXEL_RATIO,
 * so it is sharp at any zoom). Placeholders take the first page's shape; a page that
 * differs takes its own once drawn and keeps it when its canvas is released.
 */
function PdfPage({ doc, n, aspect, root }: { doc: PdfDocument; n: number; aspect: number; root: RefObject<HTMLDivElement | null> }) {
  const holder = useRef<HTMLDivElement>(null);
  const canvas = useRef<HTMLCanvasElement>(null);
  const [state, setState] = useState<"waiting" | "done" | "failed">("waiting");
  const [ratio, setRatio] = useState(aspect);
  useEffect(() => {
    const el = holder.current;
    const target = canvas.current;
    if (!el || !target) return;
    let live = true;
    let phase: "idle" | "drawing" | "drawn" | "failed" = "idle";
    let near = false;
    let kept = true;
    const release = () => {
      target.width = 0;
      target.height = 0;
      phase = "idle";
      setState("waiting");
    };
    const draw = () => {
      phase = "drawing";
      doc
        .renderPage(n, el.clientWidth, { canvas: target, pixelRatio: Math.min(MAX_PIXEL_RATIO, window.devicePixelRatio * zoomFactor()) })
        .then((c) => {
          if (!live) return;
          setRatio(c.width / c.height);
          phase = "drawn";
          setState("done");
          if (!kept) release();
        })
        .catch(() => {
          if (!live) return;
          phase = "failed";
          setState("failed");
        });
    };
    const last = (entries: IntersectionObserverEntry[], was: boolean) => entries.at(-1)?.isIntersecting ?? was;
    const drawIo = new IntersectionObserver(
      (entries) => {
        near = last(entries, near);
        if (near && phase === "idle") draw();
      },
      { root: root.current, rootMargin: DRAW_MARGIN },
    );
    const keepIo = new IntersectionObserver(
      (entries) => {
        kept = last(entries, kept);
        if (!kept && phase === "drawn") release();
      },
      { root: root.current, rootMargin: KEEP_MARGIN },
    );
    drawIo.observe(el);
    keepIo.observe(el);
    return () => {
      live = false;
      drawIo.disconnect();
      keepIo.disconnect();
      target.width = 0;
      target.height = 0;
    };
  }, [doc, n, root]);
  return (
    <div
      ref={holder}
      role="img"
      aria-label={`Page ${String(n)}`}
      data-testid="pdf-page"
      data-page={n}
      data-rendered={state === "done" || undefined}
      className="relative w-full shrink-0 overflow-hidden border bg-muted shadow-sm"
      style={{ aspectRatio: String(ratio) }}
    >
      <canvas ref={canvas} className={cn("block size-full", state !== "done" && "invisible")} />
      {state !== "done" && (
        <span className="absolute inset-0 flex items-center justify-center text-caption">{state === "failed" ? `Page ${String(n)} did not render` : `Page ${String(n)}`}</span>
      )}
    </div>
  );
}

/**
 * A PDF's pages: a scrolling column at its box's width, each page drawn as it comes near
 * the view (IntersectionObserver). In the attachment lightbox the column is at most 85% of
 * the window tall; with `fill` it fills a flex column instead (the File tab's body).
 * `onPages` hears the page count once the document opens.
 */
export function PdfPages({ file, fill = false, onPages }: { file: Blob; fill?: boolean; onPages?: (pages: number) => void }) {
  const scroller = useRef<HTMLDivElement>(null);
  const [open, setOpen] = useState<{ doc: PdfDocument; aspect: number } | null>(null);
  const [failed, setFailed] = useState(false);
  const opened = useEffectEvent((pages: number) => {
    onPages?.(pages);
  });
  useEffect(() => {
    let live = true;
    const closed = () => !live;
    let doc: PdfDocument | null = null;
    loadPdf(file)
      .then(async (d) => {
        // Closed before the PDF opened: nothing else will destroy it.
        if (closed()) {
          d.destroy();
          return;
        }
        doc = d;
        const first = await d.pageSize(1);
        if (!live) return;
        setOpen({ doc: d, aspect: first.width / first.height });
        opened(d.pages);
      })
      .catch(() => {
        if (live) setFailed(true);
      });
    return () => {
      live = false;
      doc?.destroy();
    };
  }, [file]);
  return (
    <div
      ref={scroller}
      className={cn("overflow-y-auto p-4", fill ? "min-h-0 flex-1" : "max-h-[calc(85vh/var(--cf-zoom))] min-h-40")}
      data-testid="pdf-pages" data-pages={open?.doc.pages}>
      {failed ? (
        <p className="py-12 text-center text-body text-muted-foreground">This PDF could not be shown.</p>
      ) : open ? (
        <div className="flex flex-col gap-4">
          {Array.from({ length: open.doc.pages }, (_, i) => (
            <PdfPage key={i} doc={open.doc} n={i + 1} aspect={open.aspect} root={scroller} />
          ))}
        </div>
      ) : (
        <p className="py-12 text-center text-body text-muted-foreground">Loading…</p>
      )}
    </div>
  );
}
