import { memo, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type CSSProperties, type ReactNode } from "react";
import { useVirtualizer } from "@tanstack/react-virtual";
import { RadioGroup, RadioGroupChoice } from "@/components/ui/radio-group";
import { Tip } from "@/components/ui/tooltip";
import { cn } from "@/lib/utils";
import { useCodeViewStore } from "@/stores/codeView";
import { styleCss, type AnsiRun } from "./ansi";
import { docOf, filterCount, filterRows, rowOf, sameLine, type LogDoc, type LogRow } from "./logDoc";
import { DEBUG, ERROR, FATAL, INFO, LEVEL_NAMES, TRACE, WARN, type Level } from "./logLine";
import type { PreviewBodyProps } from "./types";
import "./log.css";

/** A row's height unwrapped (log.css line-height). */
export const LOG_ROW_H = 20;
/** The row's side padding and the gap between its columns, px. */
const PAD = 12;
const GAP = 10;
/** Space above the first row and below the last, px. */
const PAD_Y = 6;
/** The level column, in characters ("ERROR"). */
const LEVEL_COLS = 5;

type Filter = Level | "all";

/** The filter's choices, in the sketch's order; one shows when its level has lines. Error takes FATAL too. */
const FILTERS: readonly { value: Filter; label: string }[] = [
  { value: "all", label: "All" },
  { value: INFO, label: "Info" },
  { value: WARN, label: "Warn" },
  { value: ERROR, label: "Error" },
  { value: DEBUG, label: "Debug" },
  { value: TRACE, label: "Trace" },
];

const LEVEL_TEXT: Record<number, string> = {
  [TRACE]: "text-cf-text-muted",
  [DEBUG]: "text-cf-text-muted",
  [INFO]: "text-cf-info-text",
  [WARN]: "text-cf-warning-text",
  [ERROR]: "text-cf-error-text",
  [FATAL]: "text-cf-error-text",
};

const ROW_TINT: Record<number, string> = {
  [WARN]: "bg-cf-warning-surface",
  [ERROR]: "bg-cf-error-surface",
  [FATAL]: "bg-cf-error-surface",
};

/** A `.log` file: timestamps, levels (with the filter) and fields, and any ANSI colours. */
export function LogBody({ file }: PreviewBodyProps) {
  return <LogView doc={docOf(file, true)} />;
}

/** Terminal output in another text file: its ANSI colours, nothing reinterpreted. */
export function AnsiBody({ file }: PreviewBodyProps) {
  return <LogView doc={docOf(file, false)} />;
}

/** Where the reader is: the line on top and how far into it, or stuck to the bottom. */
interface Place {
  doc: LogDoc;
  line: number;
  into: number;
  bottom: boolean;
}

/** The first of `rows` at or after `line` (rows ascending); the last when none is. */
function rowAtOrAfter(rows: Uint32Array, line: number): number {
  let lo = 0;
  let hi = rows.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if ((rows[mid] ?? 0) < line) lo = mid + 1;
    else hi = mid;
  }
  return Math.min(lo, Math.max(0, rows.length - 1));
}

function LogView({ doc }: { doc: LogDoc }) {
  const wrap = useCodeViewStore((s) => s.wrap);
  const [picked, setPicked] = useState<Filter>("all");
  // A level that went away with a re-read leaves the filter on All.
  const filter = picked !== "all" && filterCount(doc, picked) === 0 ? "all" : picked;
  const rows = useMemo(() => filterRows(doc, filter), [doc, filter]);
  const count = rows ? rows.length : doc.lines;
  const lineAt = useCallback((k: number) => (rows ? (rows[k] ?? 0) : k), [rows]);
  const box = useRef<HTMLDivElement>(null);
  const sizer = useRef<HTMLDivElement>(null);
  // oxlint-disable-next-line react/incompatible-library -- TanStack Virtual returns unstable functions by design.
  const v = useVirtualizer({
    count,
    getScrollElement: () => box.current,
    estimateSize: () => LOG_ROW_H,
    paddingStart: PAD_Y,
    paddingEnd: PAD_Y,
    overscan: 16,
    getItemKey: lineAt,
  });
  const place = useRef<Place>({ doc, line: 0, into: 0, bottom: true });

  const note = () => {
    const el = box.current;
    if (!el) return;
    const bottom = el.scrollTop + el.clientHeight >= el.scrollHeight - 2;
    const item = v.getVirtualItemForOffset(el.scrollTop);
    place.current = { doc, line: item ? lineAt(item.index) : 0, into: item ? el.scrollTop - item.start : 0, bottom };
  };

  // Opens at the bottom; a re-read, a filter or the wrap keep the reader at the bottom when
  // they were there, else on the line they were reading (found by its place in the file).
  useLayoutEffect(() => {
    const el = box.current;
    if (!el) return;
    const p = place.current;
    if (p.bottom || count === 0) {
      el.scrollTop = el.scrollHeight;
      place.current = { ...p, doc, bottom: true };
      return;
    }
    const line = p.doc === doc ? p.line : sameLine(p.doc, p.line, doc);
    const k = rows ? rowAtOrAfter(rows, line) : Math.min(line, count - 1);
    if (wrap) v.scrollToIndex(k, { align: "start" });
    else el.scrollTop = PAD_Y + k * LOG_ROW_H + (lineAt(k) === p.line && p.doc === doc ? p.into : 0);
    place.current = { doc, line: lineAt(k), into: 0, bottom: false };
  }, [doc, rows, wrap, count, lineAt, v]);

  // Rows measured once drawn (wrapped) and a box that grows keep a reader at the bottom there.
  useEffect(() => {
    const el = box.current;
    const inner = sizer.current;
    if (!el || !inner) return;
    const ro = new ResizeObserver(() => {
      if (place.current.bottom) el.scrollTop = el.scrollHeight;
    });
    ro.observe(el);
    ro.observe(inner);
    return () => {
      ro.disconnect();
    };
  }, []);

  const columns = { time: doc.timeCols, level: doc.leveled };
  const lead = columns.time + (columns.level ? LEVEL_COLS : 0);
  const gaps = (columns.time ? GAP : 0) + (columns.level ? GAP : 0);
  const width = wrap ? "100%" : `max(100%, calc(${String(doc.cols + lead)}ch + ${String(2 * PAD + gaps)}px))`;

  return (
    <div className="flex min-h-0 flex-1 flex-col" data-testid="file-log" data-structured={doc.structured || undefined}>
      {doc.leveled && <LevelFilter doc={doc} value={filter} onChange={setPicked} />}
      <div ref={box} className="cf-file-log min-h-0 flex-1 overflow-auto" onScroll={note} data-testid="file-log-rows" data-count={count}>
        <div ref={sizer} style={{ height: v.getTotalSize(), width, position: "relative" }}>
          {v.getVirtualItems().map((item) => (
            <div
              key={item.key}
              data-index={item.index}
              ref={wrap ? v.measureElement : undefined}
              style={{ position: "absolute", top: 0, left: 0, right: 0, transform: `translateY(${String(item.start)}px)`, height: wrap ? undefined : LOG_ROW_H }}
            >
              <LogRowView doc={doc} line={lineAt(item.index)} wrap={wrap} />
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}

/** The level chips: All and each level the read has, with how many lines each shows. */
function LevelFilter({ doc, value, onChange }: { doc: LogDoc; value: Filter; onChange: (f: Filter) => void }) {
  const shown = FILTERS.filter((f) => f.value === "all" || filterCount(doc, f.value) > 0);
  return (
    <div className="flex shrink-0 items-center border-b border-cf-divider px-3 py-2">
      <RadioGroup
        variant="segmented"
        size="sm"
        value={String(value)}
        onValueChange={(v) => {
          onChange(v === "all" ? "all" : (Number(v) as Level));
        }}
        aria-label="Show level"
        data-testid="file-log-filter"
      >
        {shown.map((f) => (
          <RadioGroupChoice key={String(f.value)} value={String(f.value)} data-testid={`file-log-filter-${f.label.toLowerCase()}`}>
            {f.label}
            <span className="tabular-nums opacity-70">{filterCount(doc, f.value)}</span>
          </RadioGroupChoice>
        ))}
      </RadioGroup>
    </div>
  );
}

const LogRowView = memo(function LogRowView({ doc, line, wrap }: { doc: LogDoc; line: number; wrap: boolean }) {
  const row = rowOf(doc, line);
  const level = doc.levels[line] ?? 0;
  const own = doc.own[line] === 1;
  return (
    <div className={cn("flex min-h-full", ROW_TINT[level])} style={{ paddingInline: PAD, columnGap: GAP }} data-testid="file-log-row" data-line={line} data-level={LEVEL_NAMES[level] || undefined}>
      {doc.timeCols > 0 && (
        <span className="flex-none text-cf-text-muted" style={{ width: `${String(doc.timeCols)}ch` }}>
          {row.time && (row.time.short === row.time.full ? row.time.short : <Tip label={row.time.full}><span data-testid="file-log-time">{row.time.short}</span></Tip>)}
        </span>
      )}
      {doc.leveled && (
        <span className={cn("flex-none font-semibold", LEVEL_TEXT[level])} style={{ width: `${String(LEVEL_COLS)}ch` }}>
          {own ? LEVEL_NAMES[level] : ""}
        </span>
      )}
      <span className={cn("min-w-0 flex-1", wrap ? "whitespace-pre-wrap [overflow-wrap:anywhere]" : "whitespace-pre")}>{content(row)}</span>
    </div>
  );
});

/** A stretch of the row's text with a role (fields' keys and values are dimmed). */
interface Piece {
  from: number;
  to: number;
  className?: string;
}

function pieces(row: LogRow): Piece[] {
  const out: Piece[] = [];
  if (row.fieldsAt > row.from) out.push({ from: row.from, to: row.fieldsAt });
  let at = row.fieldsAt;
  for (const f of row.fields) {
    if (f.from > at) out.push({ from: at, to: f.from });
    out.push({ from: f.from, to: f.eq + 1, className: "text-cf-text-muted" });
    if (f.to > f.eq + 1) out.push({ from: f.eq + 1, to: f.to, className: "text-cf-text-secondary" });
    at = f.to;
  }
  if (at < row.text.length) out.push({ from: at, to: row.text.length });
  return out;
}

/** The row's message and fields, cut where a piece or an ANSI run starts or ends. */
function content(row: LogRow): ReactNode {
  const runs = row.runs;
  const ps = pieces(row);
  if (runs.length === 0 && ps.every((p) => !p.className)) return row.text.slice(row.from);
  const out: ReactNode[] = [];
  let r = 0;
  for (const p of ps) {
    let at = p.from;
    while (at < p.to) {
      while (r < runs.length && (runs[r]?.to ?? 0) <= at) r++;
      const run: AnsiRun | undefined = runs[r];
      let to = p.to;
      let style: CSSProperties | undefined;
      if (run && run.from <= at) {
        to = Math.min(to, run.to);
        style = styleCss(run.style);
      } else if (run) to = Math.min(to, run.from);
      const text = row.text.slice(at, to);
      out.push(
        style || p.className ? (
          <span key={at} className={p.className} style={style}>
            {text}
          </span>
        ) : (
          text
        ),
      );
      at = to;
    }
  }
  return out;
}
