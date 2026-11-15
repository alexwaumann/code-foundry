import { useMemo, useState } from "react";
import { FileJson, TriangleAlert } from "lucide-react";
import { FileEmptyState } from "../states";
import { EmptyCell } from "./CsvBody";
import { DataGrid } from "./data/DataGrid";
import { gridSortOf, setGridSort, useGridSort } from "./data/gridSort";
import { countLabel, jsonText, type JsonNode } from "./data/json";
import { jsonlOf, jsonlOrder, type JsonlRecord } from "./data/jsonlTable";
import { JsonTree, JsonValue } from "./data/JsonTree";
import { nextSort } from "./data/table";
import type { PreviewBodyProps } from "./types";

/** How much of a line's text a row draws; the row cuts it with an ellipsis well before. */
const SHOWN = 500;

/** A record's value in a column, as the grid shows it. */
function Cell({ v }: { v: JsonNode | undefined }) {
  if (v === undefined) return <EmptyCell />;
  switch (v.t) {
    case "string":
      return v.v === "" ? <span className="text-cf-text-muted">""</span> : v.v.slice(0, SHOWN);
    case "number":
      return v.raw;
    case "bool":
      return <span className={v.v ? "text-cf-success-text" : "text-cf-error-text"}>{String(v.v)}</span>;
    case "null":
      return <span className="text-cf-text-muted">null</span>;
    default:
      return <span className="text-cf-text-muted">{countLabel(v)}</span>;
  }
}

/** A line drawn across the row: one that is not JSON (flagged), or a value that is not an object. */
function Whole({ record }: { record: JsonlRecord }) {
  const node = record.node;
  if (node === null)
    return (
      <span className="inline-flex items-center gap-1.5">
        <TriangleAlert className="size-3 flex-none text-cf-error-text" aria-label="Not JSON" />
        <span className="text-cf-text-secondary">{record.raw.slice(0, SHOWN)}</span>
      </span>
    );
  if (node.t === "array")
    return (
      <>
        <span className="text-cf-text-muted">{countLabel(node)}</span> <span className="text-cf-text-secondary">{jsonText(node).slice(0, SHOWN)}</span>
      </>
    );
  return <JsonValue node={node} />;
}

/** What an open record shows: its value as a tree, or why the line is not JSON. */
function Opened({ record, name }: { record: JsonlRecord; name: string }) {
  if (record.node) return <JsonTree root={record.node} label={`${name}, line ${String(record.line)}`} testId="jsonl-record-tree" />;
  const e = record.error;
  return (
    <div className="flex flex-col gap-1 px-3 py-2" data-testid="jsonl-record-error">
      <span className="text-cf-error-text">
        Not JSON: {e?.message ?? "unreadable"}
        {e && `, column ${String(e.column)}`}
      </span>
      <span className="break-all whitespace-pre-wrap text-cf-text-secondary select-text">{record.raw}</span>
    </div>
  );
}

/**
 * The JSON Lines kind's body: one row per record in the data grid, the columns the union of
 * the objects' top-level keys; a row opens into its JSON tree on click or Enter. A line
 * that is not JSON stays, flagged, with its text.
 */
export function JsonlBody({ file, path, name }: PreviewBodyProps) {
  const table = jsonlOf(file, path);
  const sort = useGridSort(path);
  const order = useMemo(() => jsonlOrder(table, sort), [table, sort]);
  // Open records by line number, for this file only.
  const [opened, setOpened] = useState<{ path: string; lines: ReadonlySet<number> }>({ path, lines: new Set() });
  const lines = opened.path === path ? opened.lines : new Set<number>();
  if (table.records.length === 0) return <FileEmptyState icon={FileJson} heading="No records" detail="The file has no lines with JSON on them." testId="file-records-empty" />;
  const record = (r: number) => table.records[r];
  return (
    <DataGrid
      key={path}
      columns={table.columns}
      order={order}
      rowNumber={(r) => record(r)?.line ?? 0}
      cell={(r, c) => <Cell v={record(r)?.cells?.[c]} />}
      span={(r) => {
        const rec = record(r);
        return rec && !rec.cells ? <Whole record={rec} /> : null;
      }}
      flagged={(r) => record(r)?.node === null}
      sort={sort}
      onSort={(c) => {
        setGridSort(path, nextSort(gridSortOf(path), c));
      }}
      expand={{
        isOpen: (r) => lines.has(record(r)?.line ?? -1),
        toggle: (r) => {
          const line = record(r)?.line;
          if (line === undefined) return;
          const next = new Set(lines);
          if (next.has(line)) next.delete(line);
          else next.add(line);
          setOpened({ path, lines: next });
        },
        render: (r) => {
          const rec = record(r);
          return rec && <Opened record={rec} name={name} />;
        },
      }}
      empty="No records."
      label={`${name} as records`}
      testId="file-records"
    />
  );
}
