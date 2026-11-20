import { describe, expect, it, vi } from "vitest";

/*
 * /cf/jsx.js tells the frame script (internal/preview/frame.js) what it could not run and how
 * it ended, as `cf:jsx` events, so a page check hears a compile error the page only shows in
 * its box (docs/notes/page-self-check.md). Uncaught errors are the frame script's own to hear.
 */
describe("jsx.js cf:jsx events", () => {
  it("tells a script that does not compile, then the loader's end", async () => {
    vi.stubGlobal("fetch", () => Promise.reject(new Error("no page HTML in jsdom")));
    document.body.innerHTML = '<script type="text/tsx">const x = <div>{1 +}</div>;</script>';
    const told: unknown[] = [];
    window.addEventListener("cf:jsx", (e) => told.push((e as CustomEvent).detail));
    await import("./jsx");
    await vi.waitFor(() => {
      expect(told).toContainEqual({ state: "error" });
    });
    expect(told[0]).toMatchObject({ error: expect.stringMatching(/^Syntax error in /) as unknown });
    expect(told).toHaveLength(2);
    // An uncaught error later is shown, not told: the frame script hears it itself.
    window.dispatchEvent(new ErrorEvent("error", { message: "boom", error: new Error("boom") }));
    expect(told).toHaveLength(2);
    vi.unstubAllGlobals();
  });
});
