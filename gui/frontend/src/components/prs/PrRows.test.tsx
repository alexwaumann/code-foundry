import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { PullRequestView } from "@/api/gh";
import { prSummary, SLUG } from "@/test/prWorld";

// The table's own width (jsdom lays nothing out): what a test sets.
const tableWidth = vi.hoisted(() => ({ px: 1100 }));
vi.mock("@/lib/useWidth", () => ({ useWidth: () => [{ current: null }, tableWidth.px] }));

const { MergedRow, OtherPrRow, PrTable } = await import("./PrRows");
const { otherStatus, tableItems } = await import("./pageModel");

/**
 * The Pull Requests page's tables (docs/notes/prs-shrink-2-gui.md): the columns a table
 * shows at its width, in header and rows alike, and the grouped tables' repository
 * labels. Which columns fit which width is columns.test.ts; the page's sections and
 * order are PullRequestsPage.test.tsx.
 */

const T0 = Date.UTC(2026, 10, 2, 12);
const GP = "alexwaumann/ghostty-playground";
const pr = (n: number, slug = SLUG): PullRequestView => prSummary(T0, slug, n, `pr ${String(n)}`, { author: "someone", additions: 12, deletions: 3 });

const header = () => [...(document.querySelector(".text-overline")?.children ?? [])].map((h) => h.textContent);
/** Each row's grid cells, as the number of children of its grid. */
const cellCounts = () => [...document.querySelectorAll("[data-nav-key] > .grid")].map((g) => g.children.length);

afterEach(() => {
  cleanup();
  tableWidth.px = 1100;
});

describe("PrTable", () => {
  it("shows the columns its width fits, in the header and every row; a narrower table drops the least important", () => {
    const rows = [pr(2), pr(1, GP)].map((p) => ({ pr: p, status: otherStatus(p) }));
    const view = render(<PrTable section="else" rows={rows} render={(r) => <OtherPrRow row={r} viewer="me" />} />);
    expect(header()).toEqual(["#", "Author", "Title", "Status", "Checks", "Diff", "Age"]);
    expect(cellCounts()).toEqual([7, 7]);
    expect(screen.getAllByTestId("prs-diff")).toHaveLength(2);

    tableWidth.px = 612;
    view.rerender(<PrTable section="else" rows={[...rows]} render={(r) => <OtherPrRow row={r} viewer="me" />} />);
    expect(header()).toEqual(["#", "Author", "Title", "Status"]);
    expect(cellCounts()).toEqual([4, 4]);
    expect(screen.queryAllByTestId("prs-diff")).toHaveLength(0);
    expect(screen.queryAllByTestId("prs-status")).toHaveLength(2);
  });

  it("a grouped table labels each repository with its row count; labels are not options", () => {
    const rows = [pr(3), pr(2), pr(1, GP)].map((p) => ({ pr: p, involved: true }));
    render(<PrTable section="merged" rows={rows} render={(r) => <MergedRow row={r} viewer="me" />} />);
    expect([...document.querySelectorAll("[data-testid=prs-group]")].map((g) => g.textContent)).toEqual(["code-foundry2", "ghostty-playground1"]);
    expect(screen.getAllByTestId("prs-group").every((g) => g.closest("[role=option]") === null)).toBe(true);
    expect(screen.getAllByRole("option")).toHaveLength(3);
  });
});

describe("tableItems", () => {
  const nameOf = (items: ReturnType<typeof tableItems<{ pr: PullRequestView }>>) => items.map((it) => (it.kind === "group" ? `[${it.name} ${String(it.count)}]` : String(it.row.pr.number)));

  it.each([
    { name: "ungrouped: the rows alone", rows: [pr(2), pr(1, GP)], grouped: false, want: ["2", "1"] },
    { name: "grouped: a label before each run of a repository", rows: [pr(3), pr(2), pr(1, GP)], grouped: true, want: ["[code-foundry 2]", "3", "2", "[ghostty-playground 1]", "1"] },
    { name: "two repositories with one name are told apart by owner", rows: [pr(2, "a/lib"), pr(1, "b/lib"), pr(4, GP)], grouped: true, want: ["[a/lib 1]", "2", "[b/lib 1]", "1", "[ghostty-playground 1]", "4"] },
    { name: "empty", rows: [], grouped: true, want: [] },
  ])("$name", ({ rows, grouped, want }) => {
    expect(nameOf(tableItems(rows.map((p) => ({ pr: p })), grouped))).toEqual(want);
  });
});
