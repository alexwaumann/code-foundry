import { describe, expect, it } from "vitest";
import { blankFile } from "@/api/files";
import { csvOf, csvOrder, csvTable, csvTsv } from "./csvTable";
import { jsonlOrder, jsonlTable, jsonlTsv } from "./jsonlTable";
import { nextSort, numberOf, sortedOrder, toTsv, type Sort } from "./table";

describe("numbers and sorting", () => {
  it.each<[string, number | null]>([
    ["42", 42],
    [" -3.5 ", -3.5],
    ["+1e3", 1000],
    [".5", 0.5],
    ["1,280.00", 1280],
    ["12,34", null],
    ["1.2.3", null],
    ["0x10", null],
    ["", null],
    ["abc", null],
  ])("numberOf(%j) = %s", (text, want) => {
    expect(numberOf(text)).toBe(want);
  });

  it("goes ascending, descending, then back to file order", () => {
    expect(nextSort(null, 2)).toEqual({ col: 2, dir: "asc" });
    expect(nextSort({ col: 2, dir: "asc" }, 2)).toEqual({ col: 2, dir: "desc" });
    expect(nextSort({ col: 2, dir: "desc" }, 2)).toBeNull();
    expect(nextSort({ col: 2, dir: "desc" }, 0)).toEqual({ col: 0, dir: "asc" });
  });

  it("sorts empty keys last both ways, ties in file order", () => {
    const keys = [3, null, 1, 3, null, 2];
    const key = (r: number) => keys[r] ?? null;
    expect(sortedOrder(6, { col: 0, dir: "asc" }, key)).toEqual([2, 5, 0, 3, 1, 4]);
    expect(sortedOrder(6, { col: 0, dir: "desc" }, key)).toEqual([0, 3, 5, 2, 1, 4]);
    expect(sortedOrder(6, null, key)).toEqual([0, 1, 2, 3, 4, 5]);
  });

  it("sorts text naturally, ignoring case", () => {
    const keys = ["item10", "Item2", "item1", "apple"];
    expect(sortedOrder(4, { col: 0, dir: "asc" }, (r) => keys[r] ?? null)).toEqual([3, 2, 1, 0]);
  });

  it("quotes a tab-separated field that needs it", () => {
    expect(toTsv([["a", "b\tc", 'say "x"', "two\nlines"]])).toBe('a\t"b\tc"\t"say ""x"""\t"two\nlines"\n');
  });
});

describe("csvTable", () => {
  const text = "id,name,mrr,note\n3,Kiln,440.00,\n1,Brightside,800.00,big\n2,Odd,,x\n";

  it("takes the header, pads short rows, marks numeric columns", () => {
    const t = csvTable("a,b,c\n1,x\n2,y,3,extra\n", "/t.csv");
    expect(t.columns.map((c) => c.name)).toEqual(["a", "b", "c", ""]);
    expect(t.rows).toEqual([
      ["1", "x", "", ""],
      ["2", "y", "3", "extra"],
    ]);
    expect(t.columns.map((c) => c.numeric)).toEqual([true, false, true, false]);
  });

  it("an empty column is not numeric, nor is a header-only file's", () => {
    expect(csvTable("a,b\n1,\n", "/t.csv").columns.map((c) => c.numeric)).toEqual([true, false]);
    const header = csvTable("a,b\n", "/t.csv");
    expect(header.rows).toEqual([]);
    expect(header.empty).toBe(false);
    expect(csvTable("", "/t.csv").empty).toBe(true);
    expect(csvTable("\n\n", "/t.csv").empty).toBe(true);
  });

  it("drops a cut read's partial last record, not a whole one", () => {
    expect(csvTable("a,b\n1,2\n3,4", "/t.csv", true).rows).toEqual([["1", "2"]]);
    expect(csvTable("a,b\n1,2\n3,4\n", "/t.csv", true).rows).toEqual([
      ["1", "2"],
      ["3", "4"],
    ]);
    expect(csvTable('a,b\n1,2\n3,"open\nquote', "/t.csv", true).rows).toEqual([["1", "2"]]);
    // A whole read keeps a last line with no line break.
    expect(csvTable("a,b\n1,2\n3,4", "/t.csv").rows).toHaveLength(2);
  });

  it("sorts numerically with empty cells last, and copies in the order shown", () => {
    const t = csvTable(text, "/t.csv");
    expect(csvOrder(t, { col: 2, dir: "asc" })).toEqual([0, 1, 2]);
    expect(csvOrder(t, { col: 0, dir: "asc" })).toEqual([1, 2, 0]);
    expect(csvOrder(t, { col: 3, dir: "desc" })).toEqual([2, 1, 0]);
    expect(csvTsv(t, { col: 0, dir: "desc" })).toBe("id\tname\tmrr\tnote\n3\tKiln\t440.00\t\n2\tOdd\t\tx\n1\tBrightside\t800.00\tbig\n");
    // A sort of a column the file no longer has is file order.
    expect(csvOrder(t, { col: 9, dir: "asc" })).toEqual([0, 1, 2]);
  });

  it("is parsed once per contents", () => {
    const a = { ...blankFile("/t.csv"), text };
    const b = { ...blankFile("/t.csv"), text: text.slice(0) };
    expect(csvOf(a, "/t.csv")).toBe(csvOf(b, "/t.csv"));
    expect(csvOf({ ...a, text: `${text}4,New,1,\n` }, "/t.csv")).not.toBe(csvOf(a, "/t.csv"));
  });
});

describe("jsonlTable", () => {
  const lines = ['{"id":"a","n":3,"tags":["x"]}', "", '{"id":"b","extra":true,"n":1}', "not json", "[1,2]", '{"id":"c","n":null}', '"text"'];
  const t = jsonlTable(`${lines.join("\n")}\n`);

  it("unions the keys in first-seen order and numbers rows by line", () => {
    expect(t.columns.map((c) => c.name)).toEqual(["id", "n", "tags", "extra"]);
    expect(t.records.map((r) => r.line)).toEqual([1, 3, 4, 5, 6, 7]);
    expect(t.invalid).toBe(1);
    expect(t.records[2]?.node).toBeNull();
    expect(t.records[2]?.raw).toBe("not json");
    expect(t.records[3]?.cells).toBeNull();
    expect(t.records[1]?.cells?.[2]).toBeUndefined();
  });

  it("calls a column numeric when every value in it is a number (null is not)", () => {
    expect(t.columns.map((c) => c.numeric)).toEqual([false, false, false, false]);
    expect(jsonlTable('{"n":1}\n{"n":2.5}\n{}\n').columns[0]?.numeric).toBe(true);
  });

  it("sorts with missing, null and non-object rows last", () => {
    const u = jsonlTable('{"n":3}\n{"n":null}\n{"n":1}\nbad\n{"n":2}\n');
    const sort: Sort = { col: 0, dir: "asc" };
    expect(jsonlOrder(u, sort).map((i) => u.records[i]?.line)).toEqual([3, 5, 1, 2, 4]);
    expect(jsonlOrder(u, { col: 0, dir: "desc" }).map((i) => u.records[i]?.line)).toEqual([1, 5, 3, 2, 4]);
  });

  it("copies nested values as JSON and other lines as their text", () => {
    expect(jsonlTsv(t, null)).toBe(["id\tn\ttags\textra", 'a\t3\t"[""x""]"\t', "b\t1\t\ttrue", "not json", "[1,2]", "c\tnull\t\t", '"""text"""', ""].join("\n"));
  });

  it("drops a cut read's last line unless the cut fell on a line break", () => {
    expect(jsonlTable('{"a":1}\n{"a":2}\n{"a"', true).records).toHaveLength(2);
    expect(jsonlTable('{"a":1}\n{"a":2}\n', true).records).toHaveLength(2);
    expect(jsonlTable('{"a":1}\n{"a":2}', false).records).toHaveLength(2);
  });

  it("takes CRLF and a BOM, and skips blank lines", () => {
    const u = jsonlTable('﻿{"a":1}\r\n\r\n  \r\n{"a":2}\r\n');
    expect(u.invalid).toBe(0);
    expect(u.records.map((r) => r.line)).toEqual([1, 4]);
  });
});
