import { useId, useMemo, useRef, useState, type KeyboardEvent } from "react";
import { useVirtualizer } from "@tanstack/react-virtual";
import { ChevronRight } from "lucide-react";
import { cn } from "@/lib/utils";
import { countLabel, type JsonNode } from "./json";
import { initialOpen, treeRows, type TreeRow } from "./treeRows";
import "./data.css";

/** A tree row's height in px. */
export const TREE_ROW = 20;
/** An inline tree (a JSON Lines record) grows to this many rows, then scrolls. */
const INLINE_ROWS = 20;
/** The most of a long string a row draws; Source has the rest. */
const STRING_SHOWN = 2000;

/** A value as the tree shows it: a string quoted with its escapes, a number as written. */
export function JsonValue({ node }: { node: JsonNode }) {
  switch (node.t) {
    case "string": {
      const s = JSON.stringify(node.v.length > STRING_SHOWN ? node.v.slice(0, STRING_SHOWN) : node.v);
      return <span className="cf-json-str">{node.v.length > STRING_SHOWN ? `${s.slice(0, -1)}…"` : s}</span>;
    }
    case "number":
      return <span className="cf-json-num">{node.raw}</span>;
    case "bool":
      return <span className="cf-json-kw">{String(node.v)}</span>;
    case "null":
      return <span className="cf-json-kw">null</span>;
    case "object":
      return <span className="cf-json-kw">{"{}"}</span>;
    case "array":
      return <span className="cf-json-kw">[]</span>;
  }
}

/**
 * A JSON value as a collapsible tree: objects and arrays open and close, with their child
 * counts; keys and values in the syntax colours. The visible rows are flattened and
 * virtualized, so a 10,000-item array costs a screenful. Keyboard as a tree: Up/Down move,
 * Right opens (then goes to the first child), Left closes (then goes to the parent),
 * Home/End, Enter or Space toggles.
 *
 * `fill`: it fills its box and scrolls (the Tree preview). Otherwise it is as tall as its
 * rows up to INLINE_ROWS (an expanded JSON Lines record), and opens as deep as that allows.
 */
export function JsonTree({ root, fill = false, label, testId }: { root: JsonNode; fill?: boolean; label: string; testId: string }) {
  const opening = (r: JsonNode) => (fill ? initialOpen(r, 0, 400) : initialOpen(r, Infinity, INLINE_ROWS * 4));
  // Which nodes are open; a new parse (the file changed) opens as a new file does.
  const [state, setState] = useState(() => ({ root, open: opening(root) }));
  if (state.root !== root) setState({ root, open: opening(root) });
  const open = state.root === root ? state.open : opening(root);
  const setOpen = (change: (was: ReadonlySet<JsonNode>) => Set<JsonNode>) => {
    setState((s) => ({ root: s.root, open: change(s.open) }));
  };
  const rows = useMemo(() => treeRows(root, open), [root, open]);
  const [active, setActive] = useState(0);
  const at = Math.min(active, rows.length - 1);
  const scrollRef = useRef<HTMLDivElement>(null);
  const id = useId();
  // oxlint-disable-next-line react/incompatible-library -- TanStack Virtual returns unstable functions by design.
  const v = useVirtualizer({ count: rows.length, getScrollElement: () => scrollRef.current, estimateSize: () => TREE_ROW, overscan: 16, paddingStart: 4, paddingEnd: 4 });

  const toggle = (row: TreeRow) => {
    if (!row.container) return;
    setOpen((was) => {
      const next = new Set(was);
      if (next.has(row.node)) next.delete(row.node);
      else next.add(row.node);
      return next;
    });
  };
  const go = (i: number) => {
    const to = Math.max(0, Math.min(rows.length - 1, i));
    setActive(to);
    v.scrollToIndex(to, { align: "auto" });
  };
  const onKeyDown = (e: KeyboardEvent<HTMLDivElement>) => {
    const row = rows[at];
    if (!row || e.metaKey || e.ctrlKey || e.altKey) return;
    const page = Math.max(1, Math.floor((scrollRef.current?.clientHeight ?? 0) / TREE_ROW) - 1);
    const moves: Record<string, () => void> = {
      ArrowDown: () => {
        go(at + 1);
      },
      ArrowUp: () => {
        go(at - 1);
      },
      PageDown: () => {
        go(at + page);
      },
      PageUp: () => {
        go(at - page);
      },
      Home: () => {
        go(0);
      },
      End: () => {
        go(rows.length - 1);
      },
      ArrowRight: () => {
        if (row.container && !row.open) toggle(row);
        else if (row.open) go(at + 1);
      },
      ArrowLeft: () => {
        if (row.open) toggle(row);
        else if (row.parent >= 0) go(row.parent);
      },
      Enter: () => {
        toggle(row);
      },
      " ": () => {
        toggle(row);
      },
    };
    const move = moves[e.key];
    if (!move) return;
    e.preventDefault();
    // An inline tree's keys stay its own (the grid around it moves between records).
    e.stopPropagation();
    move();
  };

  const height = fill ? undefined : Math.min(rows.length, INLINE_ROWS) * TREE_ROW + 8;
  return (
    <div
      ref={scrollRef}
      role="tree"
      aria-label={label}
      tabIndex={0}
      aria-activedescendant={rows.length > 0 ? `${id}-${String(at)}` : undefined}
      className={cn("cf-json-tree overflow-auto text-caption-sm text-code text-cf-text outline-none select-text focus-visible:ring-1 focus-visible:ring-cf-focus/60 focus-visible:ring-inset", fill && "min-h-0 flex-1")}
      style={{ height }}
      data-testid={testId}
      data-rows={rows.length}
      onKeyDown={onKeyDown}
    >
      <div className="relative min-w-full" style={{ height: v.getTotalSize() }}>
        {v.getVirtualItems().map((vi) => {
          const row = rows[vi.index];
          if (!row) return null;
          return (
            <div
              key={vi.key}
              id={`${id}-${String(vi.index)}`}
              role="treeitem"
              aria-level={row.depth + 1}
              aria-expanded={row.container ? row.open : undefined}
              aria-selected={vi.index === at}
              className={cn("absolute top-0 left-0 flex min-w-full items-center gap-1.5 pr-3 whitespace-pre hover:bg-cf-control-hover", vi.index === at && "[.cf-json-tree:focus-visible_&]:bg-cf-selection")}
              style={{ height: TREE_ROW, transform: `translateY(${String(vi.start)}px)`, paddingLeft: 12 + row.depth * 18 }}
              data-testid="json-row"
              onClick={() => {
                setActive(vi.index);
                toggle(row);
              }}
            >
              <span className="flex w-3 flex-none justify-center text-cf-text-muted">{row.container && <ChevronRight className={cn("size-3 transition-transform", row.open && "rotate-90")} aria-hidden />}</span>
              <RowText row={row} />
            </div>
          );
        })}
      </div>
    </div>
  );
}

function RowText({ row }: { row: TreeRow }) {
  const key = row.key === null ? null : typeof row.key === "number" ? <span className="text-cf-text-muted">{row.key}</span> : <span className="cf-json-key">{row.key === "" ? '""' : row.key}</span>;
  if (row.container)
    return (
      <>
        {key}
        <span className="text-caption-sm">{countLabel(row.node)}</span>
      </>
    );
  return (
    <>
      {key}
      {key && <span className="text-cf-text-muted">:</span>}
      <JsonValue node={row.node} />
    </>
  );
}
