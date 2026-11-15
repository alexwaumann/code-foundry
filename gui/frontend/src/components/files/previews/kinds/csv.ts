import { extOf } from "@/lib/filePath";
import { formatSize } from "../../fileKind";
import { CsvBody } from "../CsvBody";
import { csvOf, csvTsv } from "../data/csvTable";
import { gridSortOf } from "../data/gridSort";
import { plural } from "../data/table";
import type { PreviewKind } from "../types";

/**
 * CSV and TSV: Table | Source. The table is the file parsed once per read (data/csv.ts),
 * the first record its header; sorting is view only. Copy contents in Table copies
 * tab-separated text in the order shown.
 */
const csv: PreviewKind = {
  id: "csv",
  match: { ext: ["csv", "tsv"], mime: ["text/csv", "text/tab-separated-values"] },
  modes: [{ id: "table", label: "Table" }],
  Body: CsvBody,
  meta: ({ file, path }) => {
    const t = csvOf(file, path);
    const name = extOf(path) === "tsv" ? "TSV" : "CSV";
    return `${plural(t.rows.length, "row")} · ${plural(t.columns.length, "column")} · ${formatSize(file.size)} · ${name}`;
  },
  copy: ({ file, path }) => csvTsv(csvOf(file, path), gridSortOf(path)),
};

export default csv;
