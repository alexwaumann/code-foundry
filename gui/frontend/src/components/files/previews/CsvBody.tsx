import { useMemo } from "react";
import { Table } from "lucide-react";
import { FileEmptyState } from "../states";
import { csvOf, csvOrder } from "./data/csvTable";
import { DataGrid } from "./data/DataGrid";
import { gridSortOf, setGridSort, useGridSort } from "./data/gridSort";
import { nextSort } from "./data/table";
import type { PreviewBodyProps } from "./types";

/** A dim ∅: a cell with nothing in it. */
export function EmptyCell() {
  return (
    <span className="text-cf-text-muted" aria-label="empty">
      ∅
    </span>
  );
}

/** The CSV kind's body: the file as a sortable grid, the first record its header. */
export function CsvBody({ file, path, name }: PreviewBodyProps) {
  const table = csvOf(file, path);
  const sort = useGridSort(path);
  const order = useMemo(() => csvOrder(table, sort), [table, sort]);
  if (table.empty) return <FileEmptyState icon={Table} heading="Empty file" detail="No header and no rows to show." testId="file-table-empty" />;
  return (
    <DataGrid
      key={path}
      columns={table.columns}
      order={order}
      rowNumber={(r) => r + 1}
      cell={(r, c) => {
        const v = table.rows[r]?.[c] ?? "";
        return v === "" ? <EmptyCell /> : v;
      }}
      sort={sort}
      onSort={(c) => {
        setGridSort(path, nextSort(gridSortOf(path), c));
      }}
      empty="No rows: the file has a header only."
      label={`${name} as a table`}
      testId="file-table"
    />
  );
}
