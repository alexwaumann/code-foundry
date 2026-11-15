import { describe, expect, it } from "vitest";
import { delimiterFor, parseCsv, sniffDelimiter } from "./csv";

describe("parseCsv", () => {
  // Each case: the text, the records, and whether it ends clean (on a record's end).
  it.each<[string, string, string[][], boolean]>([
    ["empty", "", [], true],
    ["one field", "a", [["a"]], false],
    ["header only", "a,b,c\n", [["a", "b", "c"]], true],
    ["rows", "a,b\n1,2\n3,4\n", [["a", "b"], ["1", "2"], ["3", "4"]], true],
    ["no trailing newline", "a,b\n1,2", [["a", "b"], ["1", "2"]], false],
    ["CRLF", "a,b\r\n1,2\r\n", [["a", "b"], ["1", "2"]], true],
    ["lone CR", "a,b\r1,2\r", [["a", "b"], ["1", "2"]], true],
    ["BOM", "﻿id,name\n1,x\n", [["id", "name"], ["1", "x"]], true],
    ["quoted comma", 'a,"b,c",d\n', [["a", "b,c", "d"]], true],
    ["escaped quote", '"say ""hi""",x\n', [['say "hi"', "x"]], true],
    ["newline in quotes", 'a,"line 1\nline 2",b\n', [["a", "line 1\nline 2", "b"]], true],
    ["CRLF in quotes kept", '"x\r\ny"\r\n', [["x\r\ny"]], true],
    ["empty fields", ",,\n", [["", "", ""]], true],
    ["quoted empty field", '""\n', [[""]], true],
    ["blank lines skipped", "a\n\nb\n\n", [["a"], ["b"]], true],
    ["whitespace-only last line", "a,b\n1,2\n  ", [["a", "b"], ["1", "2"]], false],
    ["quote inside an unquoted field", 'ab"c,d\n', [['ab"c', "d"]], true],
    ["text after a closing quote", '"ab"c,d\n', [["abc", "d"]], true],
    ["ragged rows", "a,b,c\n1\n1,2,3,4\n", [["a", "b", "c"], ["1"], ["1", "2", "3", "4"]], true],
    ["trailing delimiter", "a,b,\n", [["a", "b", ""]], true],
    ["unicode", "名前,ville\n東京,Zürich\n", [["名前", "ville"], ["東京", "Zürich"]], true],
  ])("%s", (_name, text, records, clean) => {
    const p = parseCsv(text, ",");
    expect(p.records).toEqual(records);
    expect(p.endsClean).toBe(clean);
    expect(p.openQuote).toBe(false);
  });

  it("splits on tabs for TSV, where commas are text", () => {
    expect(parseCsv("a\tb,c\n1\t2\n", "\t").records).toEqual([
      ["a", "b,c"],
      ["1", "2"],
    ]);
  });

  it("says when the text ends inside quotes", () => {
    const p = parseCsv('a,b\n1,"cut sh', ",");
    expect(p.openQuote).toBe(true);
    expect(p.endsClean).toBe(false);
    expect(p.records).toEqual([
      ["a", "b"],
      ["1", "cut sh"],
    ]);
  });
});

describe("delimiters", () => {
  it.each<[string, string, string]>([
    ["data.tsv", "a,b\tc\n", "\t"],
    ["data.csv", "a,b,c\n", ","],
    ["data.csv", "a;b;c\n1,5;2;3\n", ";"],
    ["data.csv", "a\tb\tc\n", "\t"],
    ["data.csv", '"x;y",b\n', ","],
    ["data.csv", "one\n", ","],
    ["DATA.TSV", "a\tb\n", "\t"],
  ])("%s %j → %j", (path, text, want) => {
    expect(delimiterFor(path, text)).toBe(want);
  });

  it("reads only the first line", () => {
    expect(sniffDelimiter("a,b\nc;d;e;f\n")).toBe(",");
  });
});
