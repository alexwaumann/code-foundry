import { useEffect, useLayoutEffect, useRef, useState, type RefObject } from "react";
import { CornerDownLeft, Quote } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Popover, PopoverAnchor, PopoverContent } from "@/components/ui/popover";
import { Textarea } from "@/components/ui/textarea";
import { CITE_EDGE, CITE_GAP, citableItem, newCitationId, placeCite, quoteAt, type CitationBody, type CitePlacement, type CiteSide } from "@/lib/citation";
import { zoomFactor } from "@/lib/zoom";
import { findCitation, putCitation } from "@/stores/compose";
import { endEdit, focusCiteTarget, insertCite, takeFlash, useCiteStore } from "@/stores/cite";
import { threadDraftKey } from "@/stores/threadActions";
import { CITE_ITEM_ATTR, citeItemSelector, clampToRoot, highlightsSupported, lineRects, offsetOf, paint, plainText, rangeOf, type CitePaint } from "./citeDom";
import { dockTop, frame, revealQuote } from "./reveal";
import "./cite.css";

/** Where the floating surface hangs: a span of an answer's plain text, centred on a pointer x (px from the pane's left) or the span's end. */
interface CiteAnchor {
  itemId: string;
  start: number;
  end: number;
  x: number | "end";
}

export interface CiteOpen {
  /** button: the Cite button under a selection; comment: the comment popover. */
  mode: "button" | "comment";
  /** Null: hangs above the composer chip being edited (its source is not on screen). */
  anchor: CiteAnchor | null;
  body: CitationBody;
  /** The draft citation being edited; null for a new one. */
  editId: string | null;
  /** The tint the span is painted in while the comment popover is open. */
  tint: CitePaint;
}

/** The item id of the citable answer a node is in, inside this thread's timeline; null outside every answer. */
function itemOf(node: Node | null, timeline: Element): string | null {
  const el = node instanceof Element ? node : (node?.parentElement ?? null);
  const item = el?.closest(`[${CITE_ITEM_ATTR}]`);
  return item && timeline.contains(item) ? item.getAttribute(CITE_ITEM_ATTR) : null;
}

/** A Go to source in progress: live until the next one or the unmount; the timer ends its flash. */
interface FlashRun {
  live: boolean;
  timer: ReturnType<typeof setTimeout> | undefined;
}

const sameRange = (a: Range, b: Range) => a.startContainer === b.startContainer && a.startOffset === b.startOffset && a.endContainer === b.endContainer && a.endOffset === b.endOffset;

function cancelFlash(run: FlashRun | null): void {
  if (!run) return;
  run.live = false;
  clearTimeout(run.timer);
}

const HIDDEN: CitePlacement = { left: -10_000, top: -10_000, side: "below", visible: false, room: 0 };

/**
 * Cite text from Claude's answers into the composer (docs/notes/citations.md). A mouseup
 * that leaves a selection inside one answer (lib/citation citableItem) shows a Cite
 * button under the selection's last line, centred where the pointer let go; Cite turns
 * it into the comment popover in place (Enter saves, Shift+Enter a new line, Escape or a
 * click outside cancels), and Save inserts a citation tag at the composer's caret. A
 * composer chip's click (stores/cite requestEdit) scrolls to its quote, paints it amber
 * and opens the same popover to edit the comment; a sent chip's Go to source
 * (requestFlash) scrolls there and flashes it. Placement (lib/citation placeCite) is
 * recomputed every frame while shown, so it follows the timeline's scroll and hides
 * while its line is out of view. One per thread body; `paneRef` is the body under the
 * header (the edges, the timeline and the composer dock).
 */
export function CiteLayer({ threadId, paneRef }: { threadId: string; paneRef: RefObject<HTMLElement | null> }) {
  const draftKey = threadDraftKey(threadId);
  const [open, setOpen] = useState<CiteOpen | null>(null);
  const [visible, setVisible] = useState(false);
  const [comment, setComment] = useState("");
  const openRef = useRef(open);
  useLayoutEffect(() => {
    openRef.current = open;
  });
  const contentRef = useRef<HTMLDivElement>(null);
  const fieldRef = useRef<HTMLTextAreaElement>(null);
  const placement = useRef<CitePlacement>(HIDDEN);
  const side = useRef<CiteSide | null>(null);
  const virtualRef = useRef({ getBoundingClientRect: () => DOMRect.fromRect({ x: placement.current.left, y: placement.current.top, width: 0, height: 0 }) });

  const close = () => {
    const was = openRef.current;
    openRef.current = null;
    setOpen(null);
    setVisible(false);
    placement.current = HIDDEN;
    paint("cf-cite-held", null);
    paint("cf-cite-mark", null);
    if (was?.editId) {
      endEdit();
      // Back to the prompt, the caret after the chip (the click left it selected).
      focusCiteTarget(draftKey);
    }
  };

  // A mouseup that leaves a selection in one answer: the Cite button. Anything else
  // (a collapsed selection, one that leaves its answer) takes the button away.
  useEffect(() => {
    const evaluate = (x: number) => {
      if (openRef.current?.mode === "comment") return;
      const pane = paneRef.current;
      const timeline = pane?.querySelector('[data-testid="thread-timeline"]');
      const sel = window.getSelection();
      let id: string | null = null;
      let root: Element | null = null;
      let r: Range | null = null;
      if (sel && pane && timeline && !sel.isCollapsed && sel.rangeCount > 0) {
        const range = sel.getRangeAt(0);
        const ends = [itemOf(sel.anchorNode, timeline), itemOf(sel.focusNode, timeline)];
        id = citableItem(ends[0] ?? null, ends[1] ?? null, sel.toString());
        root = id ? pane.querySelector(citeItemSelector(id)) : null;
        r = range;
        // One end past the answer (a triple-click ends at the next row's start) with no
        // text selected there: the part in the answer.
        for (const end of ends) {
          if (id || !end) continue;
          const el = pane.querySelector(citeItemSelector(end));
          const inside = el && clampToRoot(range, el);
          if (inside?.toString().trim()) {
            id = end;
            root = el;
            r = inside;
          }
        }
      }
      if (!sel || !pane || !id || !root || !r) {
        if (openRef.current) close();
        return;
      }
      const pt = plainText(root);
      const q = quoteAt(pt.text, offsetOf(pt, r.startContainer, r.startOffset), offsetOf(pt, r.endContainer, r.endOffset));
      if (!q) {
        if (openRef.current) close();
        return;
      }
      side.current = null;
      setOpen({ mode: "button", anchor: { itemId: id, start: q.start, end: q.end, x: x - pane.getBoundingClientRect().left }, body: { threadId, itemId: id, comment: "", ...q }, editId: null, tint: "cf-cite-held" });
    };
    let pending: ReturnType<typeof setTimeout> | undefined;
    const onUp = (e: MouseEvent) => {
      if (e.button !== 0 || (e.target instanceof Node && contentRef.current?.contains(e.target))) return;
      // After the browser has settled the selection (a click inside one collapses it after mouseup).
      clearTimeout(pending);
      pending = setTimeout(() => {
        evaluate(e.clientX);
      }, 0);
    };
    const onSelection = () => {
      const o = openRef.current;
      if (o?.mode === "button" && window.getSelection()?.isCollapsed !== false) close();
    };
    document.addEventListener("mouseup", onUp);
    document.addEventListener("selectionchange", onSelection);
    return () => {
      clearTimeout(pending);
      document.removeEventListener("mouseup", onUp);
      document.removeEventListener("selectionchange", onSelection);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps -- close reads refs and the thread's draft key only (both fixed for this layer).
  }, [threadId, paneRef]);

  // A composer chip asks to edit its comment: go to the quote, then open the popover there
  // (above the chip when the quote is not in this thread any more).
  const editing = useCiteStore((s) => (s.editing?.draftKey === draftKey ? s.editing.citationId : null));
  useEffect(() => {
    if (!editing) return;
    const c = findCitation(draftKey, editing);
    const pane = paneRef.current;
    if (!c || !pane) {
      endEdit();
      return;
    }
    let live = true;
    void revealQuote(threadId, pane, c).then((at) => {
      if (!live || useCiteStore.getState().editing?.citationId !== editing) return;
      side.current = null;
      setComment(c.comment);
      setOpen({ mode: "comment", anchor: at && { itemId: c.itemId, start: at.start, end: at.end, x: "end" }, body: c, editId: c.id, tint: "cf-cite-mark" });
    });
    return () => {
      live = false;
    };
  }, [editing, draftKey, threadId, paneRef]);

  // A sent chip's Go to source: scroll to the quote and flash it. The layer takes the
  // request (the store forgets it), so a layer mounting later (back to this thread) does
  // not replay it; the run is cancelled by the next request or the unmount, not by that.
  const flash = useCiteStore((s) => (s.flash?.threadId === threadId ? s.flash : null));
  const flashRun = useRef<FlashRun | null>(null);
  useEffect(() => {
    const pane = paneRef.current;
    if (!flash || !pane) return;
    takeFlash(flash.seq);
    cancelFlash(flashRun.current);
    const run: FlashRun = { live: true, timer: undefined };
    flashRun.current = run;
    const alive = () => run.live;
    void revealQuote(threadId, pane, flash.cite).then(async (at) => {
      if (!alive() || !at) return;
      await frame();
      const root = pane.querySelector(citeItemSelector(flash.cite.itemId));
      if (!root || !alive()) return;
      const pt = plainText(root);
      paint("cf-cite-mark", rangeOf(pt, at.start, at.end), lineRects(pt, at.start, at.end));
      run.timer = setTimeout(() => {
        if (!openRef.current) paint("cf-cite-mark", null);
      }, 1600);
    });
  }, [flash, threadId, paneRef]);

  // While shown: place it every frame (it follows the scroll and the field's growth),
  // hide it while its line is out of view, keep the span painted while commenting.
  useEffect(() => {
    if (!open) return;
    let raf = 0;
    let painted: Range | null = null;
    const tick = () => {
      raf = requestAnimationFrame(tick);
      const pane = paneRef.current;
      const content = contentRef.current;
      if (!pane || !content) return;
      const box = pane.getBoundingClientRect();
      const size = content.getBoundingClientRect();
      const floor = dockTop(pane);
      let p: CitePlacement | null = null;
      if (open.anchor) {
        const root = pane.querySelector(citeItemSelector(open.anchor.itemId));
        const pt = root ? plainText(root) : null;
        const rects = pt ? lineRects(pt, open.anchor.start, open.anchor.end) : [];
        const first = rects[0];
        const last = rects[rects.length - 1];
        if (root && pt && first && last) {
          const x = open.anchor.x === "end" ? last.right : box.left + open.anchor.x;
          p = placeCite({ first, last, x, width: size.width, height: size.height, pane: box, floor, side: open.mode === "comment" ? (side.current ?? undefined) : undefined });
          if (open.mode === "comment") {
            side.current ??= p.side;
            // Repainted when the span's text nodes change (the row remounted, the markdown
            // re-rendered while streaming): a range over replaced nodes paints nothing.
            const r = rangeOf(pt, open.anchor.start, open.anchor.end);
            if (!highlightsSupported() || !r || !painted || !sameRange(painted, r)) {
              painted = r;
              paint(open.tint, r, rects);
            }
          }
        }
      } else if (open.editId) {
        const chip = pane.querySelector(`[data-cite="${CSS.escape(open.editId)}"]`)?.getBoundingClientRect();
        if (chip) {
          const left = Math.max(box.left + CITE_EDGE, Math.min(chip.left + chip.width / 2 - size.width / 2, box.right - CITE_EDGE - size.width));
          p = { left, top: chip.top - CITE_GAP - size.height, side: "above", visible: true, room: chip.top - CITE_GAP - box.top - CITE_EDGE };
        }
      }
      if (p) placement.current = p;
      const shown = p?.visible === true;
      setVisible(shown);
      // The field grows with its text up to the room on its side, then scrolls.
      const field = fieldRef.current;
      if (p && field) {
        const chrome = size.height - field.getBoundingClientRect().height;
        field.style.maxHeight = `${String(Math.max(36, (p.room - chrome) / zoomFactor()))}px`;
      }
    };
    tick();
    return () => {
      cancelAnimationFrame(raf);
    };
  }, [open, paneRef]);

  // Unmounted (another thread, the thread gone): nothing stays painted or marked.
  useEffect(
    () => () => {
      cancelFlash(flashRun.current);
      paint("cf-cite-held", null);
      paint("cf-cite-mark", null);
      // An edit of this draft's chip (open, or still finding its quote) ends with it.
      if (useCiteStore.getState().editing?.draftKey === draftKey) endEdit();
    },
    [draftKey],
  );

  const toComment = () => {
    if (!open) return;
    side.current = null;
    setComment("");
    setOpen({ ...open, mode: "comment" });
  };

  const save = () => {
    if (!open) return;
    const text = comment.trim();
    if (open.editId) {
      const c = findCitation(draftKey, open.editId);
      if (c) putCitation(draftKey, { ...c, comment: text });
      close();
      return;
    }
    const c = { ...open.body, id: newCitationId(), comment: text };
    putCitation(draftKey, c);
    close();
    window.getSelection()?.removeAllRanges();
    insertCite(draftKey, c.id);
  };

  return (
    <Popover
      open={open !== null}
      onOpenChange={(o) => {
        if (!o) close();
      }}
    >
      <PopoverAnchor virtualRef={virtualRef} />
      {open && (
        <PopoverContent
          ref={contentRef}
          side="bottom"
          align="start"
          sideOffset={0}
          avoidCollisions={false}
          updatePositionStrategy="always"
          data-testid={open.mode === "button" ? "cite-button-surface" : "cite-popover"}
          data-mode={open.mode}
          data-editing={open.editId ? "" : undefined}
          data-hidden={visible ? undefined : ""}
          className={open.mode === "button" ? "w-auto rounded-md border-[color-mix(in_oklab,var(--foreground)_12%,var(--border))] p-0 data-[hidden]:invisible" : "w-80 p-2 data-[hidden]:invisible"}
          onOpenAutoFocus={(e) => {
            e.preventDefault();
            if (open.mode === "comment") fieldRef.current?.focus();
          }}
          onCloseAutoFocus={(e) => {
            e.preventDefault();
          }}
        >
          {open.mode === "button" ? (
            <button
              type="button"
              data-testid="cite-button"
              className="flex h-7 items-center gap-1.5 pr-2.5 pl-2 text-body-sm font-medium outline-none hover:bg-[color-mix(in_oklab,var(--foreground)_6%,var(--popover))] focus-visible:bg-[color-mix(in_oklab,var(--foreground)_6%,var(--popover))]"
              onMouseDown={(e) => {
                e.preventDefault();
              }}
              onClick={toComment}
            >
              <Quote aria-hidden className="size-3 fill-current stroke-0 text-warning" />
              Cite
            </button>
          ) : (
            <CommentForm open={open} shown={visible} comment={comment} setComment={setComment} fieldRef={fieldRef} onSave={save} onCancel={close} />
          )}
        </PopoverContent>
      )}
    </Popover>
  );
}

/** The comment popover's body: a growing multi-line field, then Cancel and Save at the bottom right. */
export function CommentForm({
  open,
  shown,
  comment,
  setComment,
  fieldRef,
  onSave,
  onCancel,
}: {
  open: CiteOpen;
  /** Placed and visible: only then can the field take the keyboard (a hidden one cannot). */
  shown: boolean;
  comment: string;
  setComment: (s: string) => void;
  fieldRef: RefObject<HTMLTextAreaElement | null>;
  onSave: () => void;
  onCancel: () => void;
}) {
  // The field fits its text (WebKit has no field-sizing), within its max height (the frame loop sets it).
  useLayoutEffect(() => {
    const field = fieldRef.current;
    if (!field) return;
    field.style.height = "auto";
    field.style.height = `${String(field.scrollHeight + 2)}px`;
  }, [comment, fieldRef]);
  // Focus once shown (the button turned into the form, or an edit opened it: hidden until its first placement).
  useEffect(() => {
    const field = fieldRef.current;
    if (!field || !shown) return;
    field.focus();
    field.setSelectionRange(field.value.length, field.value.length);
  }, [fieldRef, shown, open.editId, open.body]);
  return (
    <form
      onSubmit={(e) => {
        e.preventDefault();
        onSave();
      }}
    >
      <Textarea
        ref={fieldRef}
        rows={1}
        value={comment}
        aria-label={open.editId ? "Edit the comment on this quote" : "Comment on this quote"}
        placeholder="Add a comment (optional)"
        data-testid="cite-comment"
        className="min-h-0 resize-none overflow-y-auto px-2.5 py-1.5 text-body-sm"
        onChange={(e) => {
          setComment(e.target.value);
        }}
        onKeyDown={(e) => {
          if (e.key === "Enter" && !e.shiftKey && !e.altKey && !e.metaKey && !e.ctrlKey && !e.nativeEvent.isComposing) {
            e.preventDefault();
            onSave();
          }
        }}
      />
      <div className="mt-2 flex justify-end gap-1.5">
        <Button type="button" variant="outline" size="xs" data-testid="cite-cancel" onClick={onCancel}>
          Cancel
        </Button>
        <Button type="submit" size="xs" data-testid="cite-save">
          Save
          <CornerDownLeft aria-hidden className="opacity-70" />
        </Button>
      </div>
    </form>
  );
}
