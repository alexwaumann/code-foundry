import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { Progress } from "./progress";

afterEach(cleanup);

describe("Progress", () => {
  it("without a value is indeterminate: no aria-valuenow, a sliding bar", () => {
    render(<Progress aria-label="Installing" />);
    const bar = screen.getByRole("progressbar", { name: "Installing" });
    expect(bar.getAttribute("data-state")).toBe("indeterminate");
    expect(bar.hasAttribute("aria-valuenow")).toBe(false);
    const indicator = bar.querySelector<HTMLElement>('[data-slot="progress-indicator"]');
    expect(indicator?.className).toContain("animate-[cf-indeterminate");
    expect(indicator?.style.transform).toBe("");
  });

  it("with a value reports it and moves the indicator", () => {
    render(<Progress value={40} aria-label="Downloading" />);
    const bar = screen.getByRole("progressbar", { name: "Downloading" });
    expect(bar.getAttribute("aria-valuenow")).toBe("40");
    const indicator = bar.querySelector<HTMLElement>('[data-slot="progress-indicator"]');
    expect(indicator?.className).not.toContain("animate-");
    expect(indicator?.style.transform).toBe("translateX(-60%)");
  });
});
