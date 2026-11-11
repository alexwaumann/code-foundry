import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { RadioGroup, RadioGroupChoice } from "./radio-group";

afterEach(cleanup);

function Group({ size, onValueChange }: { size?: "default" | "sm"; onValueChange?: (v: string) => void }) {
  return (
    <RadioGroup variant="segmented" size={size} value="a" onValueChange={onValueChange} aria-label="Pick" data-testid="g">
      <RadioGroupChoice value="a" data-testid="a">
        A
      </RadioGroupChoice>
      <RadioGroupChoice value="b" data-testid="b">
        B
      </RadioGroupChoice>
    </RadioGroup>
  );
}

describe("the segmented RadioGroup", () => {
  it.each([
    [undefined, ["h-8", "rounded-lg"], ["rounded-md", "text-body-sm"]],
    ["sm" as const, ["rounded-md", "p-0.5"], ["rounded-sm", "text-caption-sm"]],
  ])("size %s: the group and its choices take that size's corners and type", (size, group, choice) => {
    render(<Group size={size} />);
    const g = screen.getByTestId("g");
    expect(g.getAttribute("role")).toBe("radiogroup");
    for (const c of group) expect(g.classList).toContain(c);
    for (const c of choice) expect(screen.getByTestId("a").classList).toContain(c);
  });

  it("marks the chosen one checked and picks another on click", () => {
    const pick = vi.fn();
    render(<Group size="sm" onValueChange={pick} />);
    expect(screen.getByTestId("a").getAttribute("aria-checked")).toBe("true");
    expect(screen.getByTestId("b").getAttribute("aria-checked")).toBe("false");
    fireEvent.click(screen.getByTestId("b"));
    expect(pick).toHaveBeenCalledWith("b");
  });
});
