import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from "@/components/ui/dropdown-menu";
import { GearMenuItem } from "./GearMenuItem";

afterEach(cleanup);

function renderMenu(run: () => void, gear: () => void, onOpenChange = vi.fn()) {
  render(
    <DropdownMenu modal={false} defaultOpen onOpenChange={onOpenChange}>
      <DropdownMenuTrigger>Actions</DropdownMenuTrigger>
      <DropdownMenuContent>
        <GearMenuItem data-testid="item" data-action="a-1" gearLabel="Edit action" onRun={run} onGear={gear}>
          <span>Dev</span>
        </GearMenuItem>
        <GearMenuItem data-testid="item" data-action="a-2" gearLabel="Edit action" onRun={vi.fn()} onGear={vi.fn()}>
          <span>Test</span>
        </GearMenuItem>
        <DropdownMenuItem data-testid="add">Add action</DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>,
  );
}

describe("GearMenuItem (docs/notes/thread-info-action-menu-gear.md)", () => {
  it("draws a gear in every item, last, a labelled untabbable button, transparent unless the item is highlighted", () => {
    renderMenu(vi.fn(), vi.fn());
    const items = screen.getAllByTestId("item");
    const gears = screen.getAllByTestId("ti-action-gear");
    expect(gears).toHaveLength(2);
    items.forEach((item, i) => {
      expect(item.lastElementChild).toBe(gears[i]);
    });
    for (const g of gears) {
      expect(g.tagName).toBe("BUTTON");
      expect(g.getAttribute("type")).toBe("button");
      expect(g.getAttribute("aria-label")).toBe("Edit action");
      expect(g.tabIndex).toBe(-1);
      expect(g.hasAttribute("data-action-gear")).toBe(true);
      const cls = g.className.split(" ");
      expect(cls).toEqual(expect.arrayContaining(["opacity-0", "group-data-highlighted/gear:opacity-100", "focus-visible:opacity-100"]));
    }
    // Add action is a plain item: no gear, no split blocks.
    const add = screen.getByTestId("add");
    expect(add.querySelector("[data-action-gear]")).toBeNull();
    expect(add.className).not.toContain("before:");
  });

  it("splits the highlight in two blocks: the item's before ends 34px short, the gear's after is the last 32px", () => {
    renderMenu(vi.fn(), vi.fn());
    const item = screen.getAllByTestId("item")[0];
    const cls = item?.className.split(" ") ?? [];
    // No tint of its own (shadcn's focus:bg-accent is replaced), an isolated item.
    expect(cls).toContain("focus:bg-transparent");
    expect(cls).not.toContain("focus:bg-accent");
    expect(cls).toEqual(
      expect.arrayContaining([
        "isolate",
        "group/gear",
        "px-2",
        "py-1.5",
        "rounded-md",
        "before:absolute",
        "before:inset-y-0",
        "before:left-0",
        "before:right-8.5",
        "before:-z-1",
        "before:rounded-l-md",
        "data-highlighted:before:bg-cf-control-hover",
        "has-[[data-action-gear]:hover]:before:bg-cf-control-hover/50",
        "has-[[data-action-gear]:focus-visible]:before:bg-cf-control-hover/50",
      ]),
    );
    const gear = screen.getAllByTestId("ti-action-gear")[0]?.className.split(" ") ?? [];
    expect(gear).not.toContain("relative");
    expect(gear).toEqual(
      expect.arrayContaining([
        "size-4",
        "ml-auto",
        "after:absolute",
        "after:inset-y-0",
        "after:right-0",
        "after:w-8",
        "after:-z-1",
        "after:rounded-r-md",
        "group-data-highlighted/gear:after:bg-cf-control-hover/50",
        "hover:after:bg-cf-control-hover",
        "focus-visible:after:bg-cf-control-hover",
        "text-cf-text-muted",
        "hover:text-cf-text",
        "focus-visible:text-cf-text",
      ]),
    );
    expect(gear.filter((c) => /(^|:)bg-/.test(c) && !c.includes("after:"))).toEqual([]);
  });

  it("a click on the item runs it; a click on the gear opens the editor and runs nothing; both close the menu", () => {
    const run = vi.fn();
    const gear = vi.fn();
    const open = vi.fn();
    renderMenu(run, gear, open);
    fireEvent.click(screen.getAllByTestId("ti-action-gear")[0] as HTMLElement);
    expect(gear).toHaveBeenCalledTimes(1);
    expect(run).not.toHaveBeenCalled();
    expect(open).toHaveBeenLastCalledWith(false);
  });

  it("a click on the item's text runs it", () => {
    const run = vi.fn();
    const gear = vi.fn();
    renderMenu(run, gear);
    fireEvent.click(screen.getByText("Dev"));
    expect(run).toHaveBeenCalledTimes(1);
    expect(gear).not.toHaveBeenCalled();
  });

  it("Enter on the item runs it; ArrowRight focuses its gear, whose Enter and Space open the editor; ArrowLeft goes back", () => {
    const run = vi.fn();
    const gear = vi.fn();
    renderMenu(run, gear);
    const item = screen.getAllByTestId("item")[0] as HTMLElement;
    const g = screen.getAllByTestId("ti-action-gear")[0] as HTMLElement;
    item.focus();
    fireEvent.keyDown(item, { key: "ArrowRight" });
    expect(document.activeElement).toBe(g);
    fireEvent.keyDown(g, { key: "ArrowLeft" });
    expect(document.activeElement).toBe(item);
    fireEvent.keyDown(item, { key: "ArrowRight" });
    fireEvent.keyDown(g, { key: "Enter" });
    expect(gear).toHaveBeenCalledTimes(1);
    expect(run).not.toHaveBeenCalled();
  });

  it("Space on the gear opens the editor, not the item's run", () => {
    const run = vi.fn();
    const gear = vi.fn();
    renderMenu(run, gear);
    const g = screen.getAllByTestId("ti-action-gear")[0] as HTMLElement;
    g.focus();
    fireEvent.keyDown(g, { key: " " });
    fireEvent.keyUp(g, { key: " " });
    expect(gear).toHaveBeenCalledTimes(1);
    expect(run).not.toHaveBeenCalled();
  });

  it("Enter on the item runs it", () => {
    const run = vi.fn();
    const gear = vi.fn();
    renderMenu(run, gear);
    const item = screen.getAllByTestId("item")[0] as HTMLElement;
    item.focus();
    fireEvent.keyDown(item, { key: "Enter" });
    expect(run).toHaveBeenCalledTimes(1);
    expect(gear).not.toHaveBeenCalled();
  });

  it("ArrowDown on the gear moves on from its item", async () => {
    renderMenu(vi.fn(), vi.fn());
    const [first, second] = screen.getAllByTestId("item") as [HTMLElement, HTMLElement];
    const g = screen.getAllByTestId("ti-action-gear")[0] as HTMLElement;
    g.focus();
    fireEvent.keyDown(g, { key: "ArrowDown" });
    // Radix's roving focus moves on a timeout.
    await waitFor(() => {
      expect(document.activeElement).toBe(second);
    });
    expect(first).not.toBe(second);
  });
});
