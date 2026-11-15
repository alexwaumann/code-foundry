import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { blankFile, type FileReadView } from "@/api/files";

// jsdom lays nothing out, so the real virtualizer mounts no rows: this one lays out every
// row at its estimated size (which rows the real one mounts is e2e's).
vi.mock("@tanstack/react-virtual", () => ({
  useVirtualizer: (o: { count: number; estimateSize: (i: number) => number; getItemKey?: (i: number) => string | number; scrollMargin?: number }) => {
    const margin = o.scrollMargin ?? 0;
    const items: { index: number; key: string | number; start: number; size: number; end: number }[] = [];
    let at = margin;
    for (let i = 0; i < o.count; i++) {
      const size = o.estimateSize(i);
      items.push({ index: i, key: o.getItemKey ? o.getItemKey(i) : i, start: at, size, end: at + size });
      at += size;
    }
    return { options: { scrollMargin: margin }, getVirtualItems: () => items, getTotalSize: () => at - margin, measureElement: () => undefined, scrollToIndex: () => undefined };
  },
}));

const { CsvBody } = await import("./CsvBody");
const { JsonBody } = await import("./JsonBody");
const { JsonlBody } = await import("./JsonlBody");
const { useGridSortStore } = await import("./data/gridSort");
const csvKind = (await import("./kinds/csv")).default;
const jsonKind = (await import("./kinds/json")).default;
const jsonlKind = (await import("./kinds/jsonl")).default;

const read = (path: string, text: string, over: Partial<FileReadView> = {}): FileReadView => ({ ...blankFile(path), text, size: text.length, lossless: true, ...over });

function show(Body: typeof CsvBody, path: string, text: string) {
  const file = read(path, text);
  const onMeta = vi.fn();
  const onMode = vi.fn();
  const r = render(<Body file={file} path={path} mode="x" name={path.slice(path.lastIndexOf("/") + 1)} place={{ project: "", dir: "/w", file: path }} page={undefined} reloads={0} findKey={undefined} onMeta={onMeta} onMode={onMode} />);
  return { ...r, file, onMeta, onMode };
}

/** The grid's rows as their cells' text, the gutter first. */
const rows = () => screen.getAllByTestId("grid-row").map((r) => [...r.querySelectorAll("[role=rowheader],[role=gridcell]")].map((c) => c.textContent));
const headers = () => screen.getAllByTestId("grid-header");

beforeEach(() => {
  useGridSortStore.setState({ byPath: {} });
});
afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

describe("CSV table", () => {
  const CSV = "id,name,mrr\n3,Kiln,440.00\n1,Brightside,\n2,Odd,9.5\n";

  it("shows the header, numbered rows, ∅ for an empty cell, numbers right-aligned", () => {
    show(CsvBody, "/w/c.csv", CSV);
    expect(headers().map((h) => h.textContent)).toEqual(["id", "name", "mrr"]);
    expect(rows()).toEqual([
      ["1", "3", "Kiln", "440.00"],
      ["2", "1", "Brightside", "∅"],
      ["3", "2", "Odd", "9.5"],
    ]);
    const mrr = screen.getAllByTestId("grid-row")[0]?.querySelectorAll("[role=gridcell]")[2];
    expect(mrr?.className).toContain("justify-end");
    expect(mrr?.className).toContain("tabular-nums");
    expect(screen.getAllByTestId("grid-row")[0]?.querySelectorAll("[role=gridcell]")[1]?.className).not.toContain("justify-end");
  });

  it("sorts on header clicks: ascending, descending, file order; numbers by value, empty last; row numbers stay with rows", () => {
    show(CsvBody, "/w/c.csv", CSV);
    const mrr = () => headers()[2] as HTMLElement;
    fireEvent.click(within(mrr()).getByRole("button"));
    expect(mrr().getAttribute("aria-sort")).toBe("ascending");
    expect(rows().map((r) => r[0])).toEqual(["3", "1", "2"]);
    fireEvent.click(within(mrr()).getByRole("button"));
    expect(mrr().getAttribute("aria-sort")).toBe("descending");
    expect(rows().map((r) => r[0])).toEqual(["1", "3", "2"]);
    fireEvent.click(within(mrr()).getByRole("button"));
    expect(mrr().getAttribute("aria-sort")).toBe("none");
    expect(rows().map((r) => r[0])).toEqual(["1", "2", "3"]);
  });

  it("says what a header-only file and an empty file are", () => {
    const { unmount } = show(CsvBody, "/w/h.csv", "id,name\n");
    expect(screen.getByTestId("file-table-empty").textContent).toContain("header only");
    unmount();
    show(CsvBody, "/w/e.csv", "");
    expect(screen.getByTestId("file-table-empty").textContent).toContain("Empty file");
  });

  it("meta and Copy contents: tab-separated, in the order shown; the sort is the file's own", () => {
    const file = read("/w/c.csv", CSV, { size: 1200 });
    expect(csvKind.meta({ file, path: "/w/c.csv" })).toBe("3 rows · 3 columns · 1 KB · CSV");
    expect(csvKind.meta({ file: read("/w/t.tsv", "a\tb\n1\t2\n"), path: "/w/t.tsv" })).toBe("1 row · 2 columns · 8 B · TSV");
    show(CsvBody, "/w/c.csv", CSV);
    fireEvent.click(within(headers()[1] as HTMLElement).getByRole("button"));
    expect(csvKind.copy?.({ file, path: "/w/c.csv" })).toBe("id\tname\tmrr\n1\tBrightside\t\n3\tKiln\t440.00\n2\tOdd\t9.5\n");
    // Another file is in its own order.
    expect(csvKind.copy?.({ file: read("/w/d.csv", CSV), path: "/w/d.csv" })).toBe("id\tname\tmrr\n3\tKiln\t440.00\n1\tBrightside\t\n2\tOdd\t9.5\n");
  });
});

describe("JSON tree", () => {
  const DOC = '{"name":"x","scripts":{"dev":"vite","build":"tsc"},"tags":["a","b"],"n":1.50,"ok":null}';
  const lines = () => screen.getAllByTestId("json-row").map((r) => r.textContent);

  it("opens the top level, with counts; arrows move and open and close", () => {
    show(JsonBody, "/w/p.json", DOC);
    expect(lines()).toEqual(['name:"x"', "scripts{2}", 'dev:"vite"', 'build:"tsc"', "tags[2]", '0:"a"', '1:"b"', "n:1.50", "ok:null"]);
    const tree = screen.getByRole("tree");
    const current = () => document.getElementById(tree.getAttribute("aria-activedescendant") ?? "")?.textContent;
    expect(current()).toBe('name:"x"');
    fireEvent.keyDown(tree, { key: "ArrowDown" });
    expect(current()).toBe("scripts{2}");
    fireEvent.keyDown(tree, { key: "ArrowLeft" });
    expect(lines()).toEqual(['name:"x"', "scripts{2}", "tags[2]", '0:"a"', '1:"b"', "n:1.50", "ok:null"]);
    expect(screen.getAllByRole("treeitem")[1]?.getAttribute("aria-expanded")).toBe("false");
    fireEvent.keyDown(tree, { key: "ArrowRight" });
    expect(lines()).toHaveLength(9);
    fireEvent.keyDown(tree, { key: "ArrowRight" });
    expect(current()).toBe('dev:"vite"');
    fireEvent.keyDown(tree, { key: "ArrowLeft" });
    expect(current()).toBe("scripts{2}");
    fireEvent.keyDown(tree, { key: "End" });
    expect(current()).toBe("ok:null");
    // A click toggles a container.
    fireEvent.click(screen.getAllByTestId("json-row")[4] as HTMLElement);
    expect(lines()).not.toContain('0:"a"');
  });

  it("meta counts an object's keys, an array's items", () => {
    expect(jsonKind.meta({ file: read("/w/p.json", DOC, { size: 2048 }), path: "/w/p.json" })).toBe("5 keys · 2 KB · JSON");
    expect(jsonKind.meta({ file: read("/w/a.json", "[1,2,3]"), path: "/w/a.json" })).toBe("3 items · 7 B · JSON");
    expect(jsonKind.meta({ file: read("/w/t.jsonc", "{// c\n}"), path: "/w/t.jsonc" })).toBe("0 keys · 7 B · JSONC");
  });

  it("not valid JSON: the error and where, the line with a caret, and a way to Source", () => {
    const { onMode } = show(JsonBody, "/w/b.json", '{\n  "a": 1\n  "b": 2\n}\n');
    const state = screen.getByTestId("file-json-invalid");
    expect(state.textContent).toContain("Not valid JSON");
    expect(state.textContent).toContain("Expected ',' or '}', found '\"' · line 3, column 3");
    expect(screen.getByTestId("file-json-excerpt").textContent).toBe('  "b": 2\n  ^');
    fireEvent.click(screen.getByTestId("file-json-source"));
    expect(onMode).toHaveBeenCalledWith("source");
  });

  it("a cut read is not a tree: it opens as code", () => {
    expect(jsonKind.shows?.(read("/w/big.json", '{"a": [1,', { truncated: true }))).toBe(false);
    expect(jsonKind.shows?.(read("/w/ok.json", "{}"))).toBe(true);
  });
});

describe("JSON Lines records", () => {
  const JSONL = ['{"id":"a","pass":true,"n":3,"usage":{"in":1,"out":2}}', "", '{"id":"b","pass":false,"n":1,"tags":["x"]}', "{broken", "[1,2]"].join("\n") + "\n";

  it("one row per line, numbered by line; columns the union of keys; nested values as counts; a broken line flagged", () => {
    show(JsonlBody, "/w/r.jsonl", JSONL);
    expect(headers().map((h) => h.textContent)).toEqual(["id", "pass", "n", "usage", "tags"]);
    expect(rows()).toEqual([
      ["1", "a", "true", "3", "{2}", "∅"],
      ["3", "b", "false", "1", "∅", "[1]"],
      ["4", "{broken"],
      ["5", "[2] [1,2]"],
    ]);
    const all = screen.getAllByTestId("grid-row");
    expect(all[2]?.hasAttribute("data-flagged")).toBe(true);
    expect(all[0]?.hasAttribute("data-flagged")).toBe(false);
  });

  it("a click or Enter opens a record into its tree; a broken one says why", () => {
    show(JsonlBody, "/w/r.jsonl", JSONL);
    const line = (i: number) => screen.getAllByTestId("grid-row")[i]?.querySelector(".cf-grid-line") as HTMLElement;
    fireEvent.click(line(0));
    const tree = screen.getByTestId("jsonl-record-tree");
    expect([...tree.querySelectorAll("[data-testid=json-row]")].map((r) => r.textContent)).toEqual(['id:"a"', "pass:true", "n:3", "usage{2}", "in:1", "out:2"]);
    expect(screen.getAllByTestId("grid-row")[0]?.getAttribute("aria-expanded")).toBe("true");
    fireEvent.click(line(0));
    expect(screen.queryByTestId("jsonl-record-tree")).toBeNull();

    const grid = screen.getByRole("grid");
    fireEvent.keyDown(grid, { key: "ArrowDown" });
    fireEvent.keyDown(grid, { key: "ArrowDown" });
    fireEvent.keyDown(grid, { key: "Enter" });
    expect(screen.getByTestId("jsonl-record-error").textContent).toContain("Not JSON: Expected a key in double quotes");
    fireEvent.keyDown(grid, { key: "ArrowLeft" });
    expect(screen.queryByTestId("jsonl-record-error")).toBeNull();
  });

  it("sorts, missing values last, and copies the order shown with nested values as JSON", () => {
    const file = read("/w/r.jsonl", JSONL, { size: 4096 });
    expect(jsonlKind.meta({ file, path: "/w/r.jsonl" })).toBe("4 records · 1 invalid line · 5 fields · 4 KB · JSON Lines");
    show(JsonlBody, "/w/r.jsonl", JSONL);
    act(() => {
      fireEvent.click(within(headers()[2] as HTMLElement).getByRole("button"));
    });
    expect(rows().map((r) => r[0])).toEqual(["3", "1", "4", "5"]);
    expect(jsonlKind.copy?.({ file, path: "/w/r.jsonl" })).toBe('id\tpass\tn\tusage\ttags\nb\tfalse\t1\t\t"[""x""]"\na\ttrue\t3\t"{""in"":1,""out"":2}"\t\n{broken\n[1,2]\n');
  });

  it("says when there are no records", () => {
    show(JsonlBody, "/w/e.jsonl", "\n\n");
    expect(screen.getByTestId("file-records-empty")).toBeTruthy();
  });
});
