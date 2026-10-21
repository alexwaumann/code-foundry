import { cleanup, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { HTML_PREVIEW_SANDBOX, HtmlPreview } from "./HtmlPreview";

const previewFile = vi.fn();
vi.mock("@/api/files", async (orig) => ({
  ...(await orig<typeof import("@/api/files")>()),
  previewFile: (...args: unknown[]) => previewFile(...args) as unknown,
}));

afterEach(() => {
  cleanup();
  previewFile.mockReset();
});

describe("HtmlPreview", () => {
  it("loads the granted URL in a sandboxed frame and names the scope", async () => {
    previewFile.mockResolvedValue({ url: "http://127.0.0.1:1/preview/g/docs/a.html", scope: "/Users/me/proj" });
    render(<HtmlPreview path="/Users/me/proj/docs/a.html" text="<p>1</p>" name="a.html" />);
    const frame = await screen.findByTestId("file-html-frame");
    expect(previewFile).toHaveBeenCalledWith("", "/Users/me/proj/docs/a.html", undefined, expect.any(AbortSignal));
    expect(frame.getAttribute("src")).toBe("http://127.0.0.1:1/preview/g/docs/a.html");
    expect(frame.getAttribute("sandbox")).toBe(HTML_PREVIEW_SANDBOX);
    expect(frame.hasAttribute("srcdoc")).toBe(false);
    expect(HTML_PREVIEW_SANDBOX).not.toContain("allow-same-origin");
    expect(HTML_PREVIEW_SANDBOX).not.toContain("allow-top-navigation");
    expect(screen.getByTestId("file-html-footer").textContent).toContain("loads files under ~/proj");
  });

  it("remounts the frame when the text changes, without asking for a new grant", async () => {
    previewFile.mockResolvedValue({ url: "http://127.0.0.1:1/preview/g/a.html", scope: "/Users/me" });
    const { rerender } = render(<HtmlPreview path="/Users/me/a.html" text="one" name="a.html" />);
    const first = await screen.findByTestId("file-html-frame");
    rerender(<HtmlPreview path="/Users/me/a.html" text="two" name="a.html" />);
    await waitFor(() => {
      expect(screen.getByTestId("file-html-frame")).not.toBe(first);
    });
    expect(previewFile).toHaveBeenCalledTimes(1);
  });

  it("shows the error with a Retry that asks again", async () => {
    previewFile.mockRejectedValueOnce(new Error("daemon says no"));
    previewFile.mockResolvedValueOnce({ url: "http://127.0.0.1:1/preview/g/a.html", scope: "/Users/me" });
    render(<HtmlPreview path="/Users/me/a.html" text="x" name="a.html" />);
    const err = await screen.findByTestId("file-html-error");
    expect(err.textContent).toContain("daemon says no");
    screen.getByRole("button", { name: "Retry" }).click();
    await screen.findByTestId("file-html-frame");
    expect(previewFile).toHaveBeenCalledTimes(2);
  });
});
