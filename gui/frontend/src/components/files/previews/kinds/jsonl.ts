import { formatSize } from "../../fileKind";
import { gridSortOf } from "../data/gridSort";
import { jsonlOf, jsonlTsv } from "../data/jsonlTable";
import { plural } from "../data/table";
import { JsonlBody } from "../JsonlBody";
import type { PreviewKind } from "../types";

/**
 * JSON Lines (.jsonl, .ndjson; the daemon says application/jsonl): Records | Source. One
 * grid row per line, the columns the objects' top-level keys; a row opens into its tree.
 * Copy contents in Records copies tab-separated text in the order shown.
 */
const jsonl: PreviewKind = {
  id: "jsonl",
  match: { ext: ["jsonl", "ndjson"], mime: ["application/jsonl"] },
  modes: [{ id: "records", label: "Records" }],
  Body: JsonlBody,
  meta: ({ file, path }) => {
    const t = jsonlOf(file, path);
    const invalid = t.invalid > 0 ? ` · ${plural(t.invalid, "invalid line")}` : "";
    return `${plural(t.records.length, "record")}${invalid} · ${plural(t.columns.length, "field")} · ${formatSize(file.size)} · JSON Lines`;
  },
  copy: ({ file, path }) => jsonlTsv(jsonlOf(file, path), gridSortOf(path)),
  source: { lang: "jsonl", name: "JSON Lines" },
};

export default jsonl;
