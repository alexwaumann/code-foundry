import { render } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { StatusCircle, WaitingCircle, WorkingCircle, type StatusCircleTone } from "./StatusCircle";

function classes(el: Element | null): string[] {
  return (el?.getAttribute("class") ?? "").split(" ");
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe("StatusCircle", () => {
  it.each<[StatusCircleTone, string, string]>([
    ["working", "animate-status-working", "text-cf-info-text"],
    ["waiting", "animate-status-waiting", "text-cf-text-muted"],
  ])("%s: the dashed circle turning at its pace, in its tone", (tone, motion, colour) => {
    const { container } = render(<StatusCircle tone={tone} className="size-3.5" />);
    const svg = container.querySelector("svg");
    expect(svg?.getAttribute("data-status-circle")).toBe(tone);
    expect(classes(svg)).toEqual(expect.arrayContaining(["lucide-circle-dashed", motion, colour, "size-3.5"]));
    // Never the app's spinner.
    expect(classes(svg)).not.toContain("animate-spin");
  });

  it.each<[StatusCircleTone, number, string]>([
    ["working", 12_345.4, "-2345ms"],
    ["waiting", 12_345.4, "-1345ms"],
    ["working", 4999.6, "-4999ms"],
  ])("%s mounting at %sms takes the page clock's phase (%s), so a remount carries on", (tone, now, delay) => {
    vi.spyOn(performance, "now").mockReturnValue(now);
    const { container } = render(<StatusCircle tone={tone} />);
    expect((container.querySelector("svg") as SVGSVGElement).style.animationDelay).toBe(delay);
  });

  it("keeps its phase across re-renders", () => {
    const now = vi.spyOn(performance, "now").mockReturnValue(1_000);
    const { container, rerender } = render(<StatusCircle tone="working" />);
    now.mockReturnValue(3_000);
    rerender(<StatusCircle tone="working" className="size-4" />);
    expect((container.querySelector("svg") as SVGSVGElement).style.animationDelay).toBe("-1000ms");
  });

  it("is not gated on prefers-reduced-motion: the turn says something is running", () => {
    const { container } = render(<StatusCircle tone="working" />);
    expect(classes(container.querySelector("svg")).filter((c) => c.startsWith("motion-"))).toEqual([]);
  });

  it("a colour in className replaces the tone's", () => {
    const { container } = render(<StatusCircle tone="waiting" className="text-cf-sidebar-muted-foreground" />);
    const c = classes(container.querySelector("svg"));
    expect(c).toContain("text-cf-sidebar-muted-foreground");
    expect(c).not.toContain("text-cf-text-muted");
  });

  it("passes other props through (aria, data, size)", () => {
    const { container } = render(<StatusCircle tone="working" aria-label="Running" data-testid="x" />);
    const svg = container.querySelector("svg");
    expect(svg?.getAttribute("aria-label")).toBe("Running");
    expect(svg?.getAttribute("data-testid")).toBe("x");
  });
});

describe("WorkingCircle and WaitingCircle (icon tables)", () => {
  it.each([
    ["working", WorkingCircle, "animate-status-working"],
    ["waiting", WaitingCircle, "animate-status-waiting"],
  ] as const)("%s takes the surrounding text's colour, turning", (tone, Icon, motion) => {
    const { container } = render(
      <span className="text-cf-warning-text">
        <Icon className="size-3.5 shrink-0" aria-hidden />
      </span>,
    );
    const c = classes(container.querySelector("svg"));
    expect(container.querySelector("svg")?.getAttribute("data-status-circle")).toBe(tone);
    expect(c).toEqual(expect.arrayContaining(["text-current", motion, "size-3.5", "shrink-0"]));
    expect(c).not.toContain("text-cf-info-text");
    expect(c).not.toContain("text-cf-text-muted");
    expect(c.filter((k) => k.startsWith("motion-"))).toEqual([]);
  });

  it("a colour passed to the icon wins over the inherited one", () => {
    const { container } = render(<WorkingCircle className="text-cf-warning-text" />);
    const c = classes(container.querySelector("svg"));
    expect(c).toContain("text-cf-warning-text");
    expect(c).not.toContain("text-current");
  });
});
