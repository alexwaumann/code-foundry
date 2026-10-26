import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { Checkbox } from "./checkbox";

afterEach(cleanup);

describe("Checkbox", () => {
  it("indeterminate is mixed and shows the dash, not the tick", () => {
    render(<Checkbox checked="indeterminate" aria-label="Some" />);
    const box = screen.getByRole("checkbox", { name: "Some" });
    expect(box.getAttribute("aria-checked")).toBe("mixed");
    expect(box.getAttribute("data-state")).toBe("indeterminate");
    expect(box.className).toContain("aria-[checked=mixed]:bg-primary");
    const icons = [...box.querySelectorAll("svg")].map((s) => s.getAttribute("class") ?? "");
    expect(icons.find((c) => c.includes("lucide-minus"))).toContain("group-data-[state=indeterminate]/checkbox:block");
    expect(icons.find((c) => c.includes("lucide-check"))).toContain("group-data-[state=indeterminate]/checkbox:hidden");
  });

  it("checked shows the tick", () => {
    render(<Checkbox checked aria-label="All" />);
    const box = screen.getByRole("checkbox", { name: "All" });
    expect(box.getAttribute("aria-checked")).toBe("true");
    expect(box.querySelector("svg.lucide-check")).not.toBeNull();
  });
});
