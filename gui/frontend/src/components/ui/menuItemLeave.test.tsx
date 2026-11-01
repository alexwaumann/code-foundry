import type * as React from "react";
import { describe, expect, it, vi } from "vitest";
import { itemLeaveWhileClosing } from "./menuItemLeave";

/** An item inside a role=menu with this data-state, and a pointerleave on it. */
function leave(state: "open" | "closed") {
  const menu = document.createElement("div");
  menu.setAttribute("role", "menu");
  menu.setAttribute("data-state", state);
  const item = document.createElement("div");
  menu.append(item);
  const preventDefault = vi.fn();
  const own = vi.fn();
  itemLeaveWhileClosing(own)({ currentTarget: item, preventDefault } as unknown as React.PointerEvent<HTMLElement>);
  return { preventDefault, own };
}

describe("itemLeaveWhileClosing", () => {
  it("leaves an open menu's pointerleave to Radix (it focuses the content)", () => {
    const { preventDefault, own } = leave("open");
    expect(preventDefault).not.toHaveBeenCalled();
    expect(own).toHaveBeenCalledOnce();
  });

  it("stops it while the menu animates out, so a dialog the item opened keeps its focus", () => {
    const { preventDefault, own } = leave("closed");
    expect(preventDefault).toHaveBeenCalledOnce();
    expect(own).toHaveBeenCalledOnce();
  });
});
