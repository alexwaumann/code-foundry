import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { setThemePreference, setThemeSlots, startThemePublish } from "@/lib/theme";
import { DEFAULT_DARK, DEFAULT_LIGHT } from "@/themes";
import { THEME_ACK_MS } from "./HtmlFrame";
import { HTML_PREVIEW_SANDBOX, HtmlPreview } from "./HtmlPreview";

const previewFile = vi.fn();
vi.mock("@/api/files", async (orig) => ({
  ...(await orig<typeof import("@/api/files")>()),
  previewFile: (...args: unknown[]) => previewFile(...args) as unknown,
}));

afterEach(() => {
  cleanup();
  previewFile.mockReset();
  setThemePreference("system");
  setThemeSlots({ light: DEFAULT_LIGHT, dark: DEFAULT_DARK });
});

describe("HtmlPreview", () => {
  it("loads the granted URL in a sandboxed frame and names the scope", async () => {
    previewFile.mockResolvedValue({ url: "http://127.0.0.1:1/preview/g/docs/a.html", scope: "/Users/me/proj", singleFile: false });
    render(<HtmlPreview path="/Users/me/proj/docs/a.html" text="<p>1</p>" name="a.html" />);
    const frame = await screen.findByTestId("file-html-frame");
    expect(previewFile).toHaveBeenCalledWith("", "/Users/me/proj/docs/a.html", undefined, expect.any(AbortSignal));
    // The frame's nonce in the fragment (docs/notes/bridge-fix-frames.md).
    expect(frame.getAttribute("src")).toMatch(/^http:\/\/127\.0\.0\.1:1\/preview\/g\/docs\/a\.html#cf=[0-9a-f]{32}$/);
    // No owning thread (no thread's panel): an opaque origin, so it cannot reach another page's frame.
    expect(frame.getAttribute("sandbox")).toBe(HTML_PREVIEW_SANDBOX);
    expect(frame.hasAttribute("srcdoc")).toBe(false);
    expect(HTML_PREVIEW_SANDBOX).not.toContain("allow-same-origin");
    expect(frame.getAttribute("allow")).toBe("clipboard-write");
    expect(HTML_PREVIEW_SANDBOX).not.toContain("allow-top-navigation");
    expect(screen.getByTestId("file-html-footer").textContent).toContain("loads files under ~/proj");
  });

  it("remounts the frame when the text changes, without asking for a new grant", async () => {
    previewFile.mockResolvedValue({ url: "http://127.0.0.1:1/preview/g/a.html", scope: "/Users/me/a.html", singleFile: true });
    const { rerender } = render(<HtmlPreview path="/Users/me/a.html" text="one" name="a.html" />);
    const first = await screen.findByTestId("file-html-frame");
    expect(screen.getByTestId("file-html-footer").textContent).toContain("loads this file only");
    rerender(<HtmlPreview path="/Users/me/a.html" text="two" name="a.html" />);
    await waitFor(() => {
      expect(screen.getByTestId("file-html-frame")).not.toBe(first);
    });
    expect(previewFile).toHaveBeenCalledTimes(1);
  });

  it("posts the theme to the frame on load and on every theme change", async () => {
    setThemePreference("dark");
    previewFile.mockResolvedValue({ url: "http://127.0.0.1:1/preview/g/a.html", scope: "/Users/me/x", singleFile: false });
    render(<HtmlPreview path="/Users/me/x/a.html" text="x" name="a.html" />);
    const frame = await screen.findByTestId<HTMLIFrameElement>("file-html-frame");
    const win = frame.contentWindow;
    if (!win) throw new Error("no contentWindow");
    const post = vi.spyOn(win, "postMessage").mockImplementation(() => undefined);
    fireEvent.load(frame);
    const [msg, target] = post.mock.lastCall ?? [];
    expect(target).toBe("*");
    expect(msg).toMatchObject({ type: "cf:theme", id: "github-dark", scheme: "dark" });
    expect((msg as { vars: Record<string, string> }).vars["--cf-text"]).toMatch(/^#/);
    act(() => {
      setThemeSlots({ dark: "nord" });
    });
    expect(post).toHaveBeenLastCalledWith(expect.objectContaining({ type: "cf:theme", id: "nord", scheme: "dark" }), "*");
    act(() => {
      setThemePreference("light");
    });
    expect(post).toHaveBeenLastCalledWith(expect.objectContaining({ type: "cf:theme", id: "github-light", scheme: "light" }), "*");
    expect(post).toHaveBeenCalledTimes(3);
  });

  it("gives the frame the app's color-scheme, which WebKit hands the page as prefers-color-scheme", async () => {
    setThemePreference("light");
    previewFile.mockResolvedValue({ url: "http://127.0.0.1:1/preview/g/a.html", scope: "/Users/me/x", singleFile: false });
    render(<HtmlPreview path="/Users/me/x/a.html" text="x" name="a.html" />);
    const frame = await screen.findByTestId<HTMLIFrameElement>("file-html-frame");
    expect(frame.style.colorScheme).toBe("light");
    act(() => {
      setThemePreference("dark");
    });
    expect(screen.getByTestId<HTMLIFrameElement>("file-html-frame").style.colorScheme).toBe("dark");
  });

  it("reloads on a new published theme unless the page acked cf:theme", async () => {
    setThemePreference("dark");
    const stop = startThemePublish(() => Promise.resolve(), () => () => undefined, 0);
    try {
      previewFile.mockResolvedValue({ url: "http://127.0.0.1:1/preview/g/a.html", scope: "/Users/me/x", singleFile: false });
      render(<HtmlPreview path="/Users/me/x/a.html" text="x" name="a.html" />);
      const frame = await screen.findByTestId<HTMLIFrameElement>("file-html-frame");
      fireEvent.load(frame);
      expect(frame.dataset.load).toBe("0");
      // A page that does not answer: the frame reloads THEME_ACK_MS after the publish.
      act(() => {
        setThemeSlots({ dark: "nord" });
      });
      await waitFor(() => {
        expect(screen.getByTestId("file-html-frame").dataset.load).toBe("1");
      });
      // A page that acks the message it was posted keeps its load.
      const next = screen.getByTestId<HTMLIFrameElement>("file-html-frame");
      fireEvent.load(next);
      act(() => {
        setThemeSlots({ dark: "dracula" });
        window.dispatchEvent(new MessageEvent("message", { data: { type: "cf:theme:ack" }, source: next.contentWindow, origin: "null" }));
      });
      await new Promise((r) => setTimeout(r, THEME_ACK_MS + 100));
      expect(screen.getByTestId("file-html-frame").dataset.load).toBe("1");
      // An ack from another window does not count.
      act(() => {
        setThemeSlots({ dark: "nord" });
        window.dispatchEvent(new MessageEvent("message", { data: { type: "cf:theme:ack" }, source: window, origin: "null" }));
      });
      await waitFor(() => {
        expect(screen.getByTestId("file-html-frame").dataset.load).toBe("2");
      });
    } finally {
      stop();
    }
  });

  it("shows the error with a Retry that asks again", async () => {
    previewFile.mockRejectedValueOnce(new Error("daemon says no"));
    previewFile.mockResolvedValueOnce({ url: "http://127.0.0.1:1/preview/g/a.html", scope: "/Users/me/x", singleFile: false });
    render(<HtmlPreview path="/Users/me/a.html" text="x" name="a.html" />);
    const err = await screen.findByTestId("file-html-error");
    expect(err.textContent).toContain("daemon says no");
    screen.getByRole("button", { name: "Retry" }).click();
    await screen.findByTestId("file-html-frame");
    expect(previewFile).toHaveBeenCalledTimes(2);
  });
});
