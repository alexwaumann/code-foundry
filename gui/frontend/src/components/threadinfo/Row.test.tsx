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

  it("names a row with an ellipsis by its text and value together", () => {
    render(
      <Row
        onActivate={vi.fn()}
        meta="#78"
        trailing={
          <RowMore label="Pull request options" testId="more" menuTestId="menu">
            <DropdownMenuItem>Copy URL</DropdownMenuItem>
          </RowMore>
        }
        testId="r"
      >
        Fix the badge
      </Row>,
    );
    expect(screen.getByRole("button", { name: "Fix the badge #78" })).toBe(screen.getByTestId("r"));
  });

  it("keeps its row marker under a wrapper's props (a wrapper's data-slot stays); a non-interactive row lights only its ellipsis block while the menu is up", () => {
    render(
      <Row
        data-slot="dropdown-menu-trigger"
        {...{ "data-ti-row": undefined }}
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
    expect(row.hasAttribute("data-ti-row")).toBe(true);
    expect(row.getAttribute("data-slot")).toBe("dropdown-menu-trigger");
    // The menu-open rule clears the row's block; the button's own block lights (below).
    expect(row.className).toContain("has-[[data-row-more][aria-expanded=true]]:before:bg-transparent!");
    expect(row.className).not.toContain("has-[[data-row-more][aria-expanded=true]]:bg-");
    // No click of its own: the text is not a target, so no hover block for it.
    expect(row.className).not.toContain("group/split");
    expect(row.className).not.toContain("hover:not-has-[[data-row-more]:hover]:before:bg-cf-control-hover");
    expect(screen.getByTestId("more").className).toContain("aria-expanded:after:bg-cf-control-hover");
  });

  it("splits the hover in two blocks: the row has no background of its own, its before is the left block and the button's after the ellipsis block", () => {
    renderSplit(vi.fn(), vi.fn());
    const row = screen.getByTestId("r");
    const cls = row.className.split(" ");
    // No whole-row tint: neither on hover, focus, nor while the menu is up.
    expect(cls.filter((c) => /(^|:)bg-/.test(c) && !c.includes("before:"))).toEqual([]);
    // Pseudos under the text: an isolated row, both blocks at z -1.
    expect(cls).toEqual(expect.arrayContaining(["isolate", "before:-z-1", "before:right-6.5", "before:rounded-l-md", "group/split"]));
    // Bright under the pointer or focus, half strength while the pointer is on the ellipsis.
    expect(cls).toEqual(
      expect.arrayContaining([
        "hover:not-has-[[data-row-more]:hover]:before:bg-cf-control-hover",
        "focus-visible:before:bg-cf-control-hover",
        "has-[[data-row-more]:hover]:before:bg-cf-control-hover/50",
      ]),
    );
    // The button is static, so its after is placed by the row: the last 24px, the row's full height.
    const more = screen.getByTestId("more").className.split(" ");
    expect(more).not.toContain("relative");
    expect(more).toEqual(
      expect.arrayContaining([
        "after:absolute",
        "after:inset-y-0",
        "after:right-0",
        "after:w-6",
        "after:-z-1",
        "after:rounded-r-md",
        "group-hover/split:after:bg-cf-control-hover/50",
        "hover:after:bg-cf-control-hover",
        "focus-visible:after:bg-cf-control-hover",
        "aria-expanded:after:bg-cf-control-hover",
        "aria-expanded:text-cf-text",
      ]),
    );
    expect(more.filter((c) => /^(hover|focus-visible|aria-expanded):bg-/.test(c))).toEqual([]);
  });

  it("leaves a row without an ellipsis on the whole-row tint", () => {
    render(
      <Row onActivate={vi.fn()} chevron="closed" testId="r">
        Shells
      </Row>,
    );
    const cls = screen.getByTestId("r").className.split(" ");
    expect(cls).toEqual(expect.arrayContaining(["hover:bg-cf-control-hover", "focus-visible:bg-cf-control-hover"]));
    expect(cls).not.toContain("isolate");
    expect(cls.filter((c) => c.includes("before:"))).toEqual([]);
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
