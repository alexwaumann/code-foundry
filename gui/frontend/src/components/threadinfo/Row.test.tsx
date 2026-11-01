import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { DropdownMenuItem } from "@/components/ui/dropdown-menu";
import { Row, RowMore } from "./Row";

afterEach(cleanup);

describe("Row: the chevron column (docs/notes/thread-info-row-menus.md)", () => {
  it.each([
    ["none", 0],
    ["closed", 1],
    ["open", 1],
  ] as const)("chevron %s renders %i chevron boxes", (chevron, n) => {
    render(
      <Row chevron={chevron} meta="3 ahead" testId="r">
        text
      </Row>,
    );
    expect(screen.queryAllByTestId("r-chevron")).toHaveLength(n);
    // Without a chevron the value is the row's last child: nothing is reserved after it.
    if (n === 0) expect(screen.getByTestId("r").lastElementChild).toBe(screen.getByTestId("r-meta"));
  });
});

describe("Row: its own click", () => {
  it("a click, Enter and Space activate; a double click's second click does not", () => {
    const go = vi.fn();
    render(
      <Row onActivate={go} testId="r">
        text
      </Row>,
    );
    const row = screen.getByTestId("r");
    fireEvent.click(row, { detail: 1 });
    fireEvent.keyDown(row, { key: "Enter" });
    fireEvent.keyDown(row, { key: " " });
    fireEvent.click(row, { detail: 2 });
    expect(go).toHaveBeenCalledTimes(3);
  });

  it("a menu trigger row does not activate: its press is the menu's", () => {
    const go = vi.fn();
    render(
      <Row onActivate={go} aria-haspopup="menu" testId="r">
        text
      </Row>,
    );
    fireEvent.click(screen.getByTestId("r"), { detail: 1 });
    fireEvent.keyDown(screen.getByTestId("r"), { key: "Enter" });
    expect(go).not.toHaveBeenCalled();
  });
});

describe("RowMore: the ellipsis of a row with its own click", () => {
  function renderSplit(go: () => void, pick: () => void): void {
    render(
      <Row
        onActivate={go}
        trailing={
          <RowMore label="Open in options" testId="more" menuTestId="menu">
            <DropdownMenuItem onSelect={pick} data-testid="item">
              Finder
            </DropdownMenuItem>
          </RowMore>
        }
        testId="r"
      >
        Open in Finder
      </Row>,
    );
  }

  it("leaves the row's accessible name to its text: the ellipsis is its own named button", () => {
    renderSplit(vi.fn(), vi.fn());
    expect(screen.getByRole("button", { name: "Open in Finder" })).toBe(screen.getByTestId("r"));
    expect(screen.getByRole("button", { name: "Open in options" })).toBe(screen.getByTestId("more"));
  });

  it("names a row by its text and value together", () => {
    render(
      <Row onActivate={vi.fn()} meta="3 files" testId="r">
        Changes
      </Row>,
    );
    expect(screen.getByRole("button", { name: "Changes 3 files" })).toBe(screen.getByTestId("r"));
  });

  it("keeps its row marker under a wrapper's data-slot, and tints a non-interactive row while its menu is up", () => {
    render(
      <Row
        data-slot="dropdown-menu-trigger"
        trailing={
          <RowMore label="Lineage options" testId="more" menuTestId="menu">
            <DropdownMenuItem>Show hidden threads</DropdownMenuItem>
          </RowMore>
        }
        testId="r"
      >
        Lineage
      </Row>,
    );
    const row = screen.getByTestId("r");
    expect(row.getAttribute("data-slot")).toBe("ti-row");
    expect(row.className).toContain("has-[[data-row-more][aria-expanded=true]]:bg-cf-control-hover");
  });

  it("is a labelled, tabbable button after the value, with no chevron", () => {
    renderSplit(vi.fn(), vi.fn());
    const more = screen.getByTestId("more");
    expect(more.tagName).toBe("BUTTON");
    expect(more.getAttribute("aria-label")).toBe("Open in options");
    expect(more.tabIndex).toBe(0);
    expect(screen.getByTestId("r").lastElementChild).toBe(more);
    expect(screen.queryByTestId("r-chevron")).toBeNull();
  });

  it("opens its menu without the row's click; an item picked in it is not the row's click either", () => {
    const go = vi.fn();
    const pick = vi.fn();
    renderSplit(go, pick);
    const more = screen.getByTestId("more");
    fireEvent.click(more, { detail: 1 });
    fireEvent.keyDown(more, { key: "Enter" });
    expect(more.getAttribute("aria-expanded")).toBe("true");
    // The menu is portalled out of the row's DOM, but React bubbles its events to the row.
    const item = screen.getByTestId("item");
    expect(screen.getByTestId("r").contains(item)).toBe(false);
    fireEvent.keyDown(item, { key: "Enter" });
    fireEvent.click(item, { detail: 1 });
    expect(pick).toHaveBeenCalled();
    expect(go).not.toHaveBeenCalled();
  });
});
