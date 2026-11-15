import { extOf } from "@/lib/filePath";
import { formatSize } from "../../fileKind";
import { jsonOf, jsonSummary } from "../data/json";
import { JsonBody } from "../JsonBody";
import type { PreviewKind } from "../types";

/**
 * JSON: Tree | Source. Strict JSON for .json, JSONC (comments, trailing commas) for .jsonc
 * and the config files editors read as JSONC (data/json.ts allowsComments). A read cut at
 * the cap cannot parse, so it is not shown this way: it opens as code under the truncated
 * notice. Not valid JSON shows where it breaks, with a way to Source.
 */
const json: PreviewKind = {
  id: "json",
  match: { ext: ["json", "jsonc"], mime: ["application/json"] },
  shows: (f) => f.text !== null && !f.truncated,
  modes: [{ id: "tree", label: "Tree" }],
  Body: JsonBody,
  meta: ({ file, path }) => `${jsonSummary(jsonOf(file, path))} · ${formatSize(file.size)} · ${extOf(path) === "jsonc" ? "JSONC" : "JSON"}`,
};

export default json;
