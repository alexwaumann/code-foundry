/**
 * The data previews' fixtures (docs/notes/file-previews-3-tables.md): a CSV, a JSON
 * document, JSON Lines, their broken and edge cases, and files near and over the 1 MiB read
 * cap for timing and the truncated read. Paths are relative to the code-foundry checkout;
 * mock/files.ts adds them with the mime the daemon reports (internal/fsx/read.go).
 */

const NAMES = ["Northwind", "Halcyon Labs", "Brightside", "Odd Numbers", "Tessellate", "Kiln & Co", "Foxglove", "Paper Lantern", "Quarry", "Sundial", "Mossback", "Tin Whistle", "Larkspur", "Copperline", "Ninebark", "Wavelength", "Saltbox", "Greywater", "Pinwheel", "Harbor & Vine", "Ironwood", "Bluebird", "Fathom", "Thistle", "Longhand", "Updraft"];
const PLANS = ["team", "pro", "team", "free", "pro", "team", "pro", "enterprise"];
const COUNTRIES = ["US", "DE", "GB", "JP", "BR"];

function customer(i: number): string[] {
  const plan = PLANS[i % PLANS.length] ?? "pro";
  const seats = plan === "free" ? 1 : plan === "pro" ? 1 + (i % 4) : plan === "team" ? 6 + ((i * 7) % 30) : 120 + (i % 400) * 3;
  const mrr = plan === "free" ? 0 : plan === "pro" ? seats * 32 : plan === "team" ? seats * 40 : seats * 55;
  const d = new Date(Date.UTC(2026, 2, 14 + (i % 600) * 5));
  const name = NAMES[i % NAMES.length] ?? "";
  return [`c_${String(1042 + i)}`, i < NAMES.length ? name : `${name} ${String(Math.floor(i / NAMES.length))}`, plan, mrr.toFixed(2), String(seats), d.toISOString().slice(0, 10), i % 9 === 3 ? "" : (COUNTRIES[i % 5] ?? "")];
}

const csvLine = (r: string[]) => r.map((c) => (/[",\n]/.test(c) ? `"${c.replace(/"/g, '""')}"` : c)).join(",");
const CSV_HEAD = ["id", "customer", "plan", "mrr", "seats", "signup", "country"];

/** Customers as CSV, `rows` of them. */
export function customersCsv(rows: number): string {
  const out = [csvLine(CSV_HEAD)];
  for (let i = 0; i < rows; i++) out.push(csvLine(customer(i)));
  return `${out.join("\n")}\n`;
}

/** The CSV's edge cases: quotes, commas and line breaks inside quotes, CRLF, a ragged row, a BOM. */
export const EDGES_CSV =
  "﻿sku,label,price,notes\r\n" +
  'A-1,"Widget, large",12.50,"says ""hello"""\r\n' +
  'A-2,Gadget,7,"two\r\nlines"\r\n' +
  "A-3,Short row\r\n" +
  "A-4,Long row,3,x,extra field\r\n" +
  "A-5,,0.25,\r\n";

export const PACKAGE_JSON = `${JSON.stringify(
  {
    name: "code-foundry-frontend",
    version: "0.22.0",
    private: true,
    type: "module",
    scripts: { dev: "vite", build: "tsc -b && vite build", test: "vitest run", lint: "oxlint", e2e: "playwright test" },
    dependencies: { "@pierre/diffs": "1.5.2", "@tanstack/react-virtual": "3.14.13", "@xterm/xterm": "6.0.0", cmdk: "1.1.1", react: "19.3.0", "react-dom": "19.3.0", zustand: "5.0.15" },
    devDependencies: { "@playwright/test": "1.64.1", tailwindcss: "4.3.3", typescript: "6.0.3", vite: "8.3.1", vitest: "5.0.3" },
    engines: { bun: ">=1.4" },
    keywords: ["claude", "worktrees", "desktop"],
  },
  null,
  2,
)}\n`;

/** Not JSON: a missing comma on line 4. */
export const BROKEN_JSON = '{\n  "name": "code-foundry",\n  "version": "0.22.0"\n  "private": true\n}\n';

function evalCase(i: number): Record<string, unknown> {
  const pass = ![2, 5, 13, 19].includes(i % 24);
  return {
    id: `case-${String(i + 1).padStart(3, "0")}`,
    pass,
    score: Math.round((pass ? 0.86 + ((i * 7) % 13) / 100 : 0.2 + ((i * 5) % 30) / 100) * 100) / 100,
    latency_ms: 900 + ((i * 397) % 3100),
    model: i % 3 === 2 ? "haiku-5.5" : "sonnet-5.5",
    usage: { input_tokens: 1800 + i * 37, output_tokens: 240 + ((i * 53) % 600) },
    tags: i % 4 === 0 ? ["regression", "tools"] : ["tools"],
  };
}

/** Eval results as JSON Lines, `rows` of them. */
export function resultsJsonl(rows: number): string {
  let out = "";
  for (let i = 0; i < rows; i++) out += `${JSON.stringify(evalCase(i))}\n`;
  return out;
}

/** JSON Lines with what is not a plain record: a broken line, a blank one, an array, a string, a record with other keys. */
export const MIXED_JSONL = [JSON.stringify(evalCase(0)), JSON.stringify(evalCase(1)), '{"id": "case-003", "pass": tru', "", "[1, 2, 3]", '"just a string"', JSON.stringify({ id: "note", text: "a record with other keys", nested: { deep: { deeper: [1, { x: null }] } } }), JSON.stringify(evalCase(3))].join("\n") + "\n";

/** A JSON document over the read cap: it cannot parse cut short, so it opens as code. */
function hugeJson(): string {
  const items = [];
  for (let i = 0; i < 9000; i++) items.push(evalCase(i));
  return `${JSON.stringify({ results: items }, null, 2)}\n`;
}

const MIME_CSV = "text/csv";
const MIME_JSON = "application/json";
const MIME_JSONL = "application/jsonl";

// Made once: fixtures() runs on every mock reset.
const BIG_CSV = customersCsv(20_800);
const HUGE_CSV = customersCsv(30_000);
const BIG_JSONL = resultsJsonl(6_700);
const HUGE_JSON = hugeJson();

/** [path under the checkout, text, mime] for every fixture. */
export function tableFiles(): [string, string, string][] {
  return [
    ["exports/customers.csv", customersCsv(26), MIME_CSV],
    ["exports/edges.csv", EDGES_CSV, MIME_CSV],
    ["exports/empty.csv", "", MIME_CSV],
    ["exports/header.csv", "id,name,mrr\n", MIME_CSV],
    ["exports/semicolons.csv", "name;price;qty\nTea;3,50;2\nCoffee;4,10;1\n", MIME_CSV],
    ["exports/customers.tsv", customersCsv(26).replace(/,/g, "\t"), "text/tab-separated-values"],
    // About 1 MiB, within the cap: the timing fixture.
    ["exports/big.csv", BIG_CSV, MIME_CSV],
    // Over the cap: a cut read.
    ["exports/huge.csv", HUGE_CSV, MIME_CSV],
    ["gui/frontend/package.json", PACKAGE_JSON, MIME_JSON],
    ["docs/broken.json", BROKEN_JSON, MIME_JSON],
    ["docs/huge.json", HUGE_JSON, MIME_JSON],
    ["evals/run-07/results.jsonl", resultsJsonl(24), MIME_JSONL],
    ["evals/run-07/mixed.jsonl", MIXED_JSONL, MIME_JSONL],
    ["evals/big.jsonl", BIG_JSONL, MIME_JSONL],
  ];
}
