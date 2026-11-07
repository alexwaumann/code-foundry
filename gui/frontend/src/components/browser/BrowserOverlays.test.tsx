import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { BROWSER_STARTING, type BrowserStateView } from "@/api/browser";

const api = vi.hoisted(() => ({
  dialog: vi.fn(() => Promise.resolve()),
  files: vi.fn(() => Promise.resolve()),
  select: vi.fn(() => Promise.resolve()),
  copy: vi.fn(() => Promise.resolve(3)),
  reveal: vi.fn(() => Promise.resolve()),
  relaunch: vi.fn(() => Promise.resolve()),
  pick: vi.fn<() => Promise<string[] | null>>(() => Promise.resolve(["/Users/me/a.txt", "/Users/me/b.txt"])),
}));
vi.mock("@/api/browser", async (orig) => ({
  ...(await orig<typeof import("@/api/browser")>()),
  answerBrowserDialog: api.dialog,
  answerBrowserFiles: api.files,
  answerBrowserSelect: api.select,
  copyFromBrowser: api.copy,
  revealBrowserDownload: api.reveal,
  relaunchBrowser: api.relaunch,
}));
vi.mock("@/api/app", async (orig) => ({ ...(await orig<typeof import("@/api/app")>()), pickFiles: api.pick }));

const { BrowserOverlays } = await import("./BrowserOverlays");

const ready: BrowserStateView = { ...BROWSER_STARTING, phase: "ready", url: "https://example.com/" };

function show(state: BrowserStateView, error = "") {
  const dismiss = vi.fn();
  const out = render(<BrowserOverlays surface="thread:t1" state={state} error={error} scale={{ x: 1, y: 1 }} onDismissError={dismiss} />);
  return { ...out, dismiss };
}

beforeEach(() => {
  vi.clearAllMocks();
});
afterEach(cleanup);

describe("phases", () => {
  it("says Chrome is starting", () => {
    show(BROWSER_STARTING);
    expect(screen.getByTestId("browser-starting").textContent).toContain("Starting Chrome");
  });

  it("covers nothing on a ready page", () => {
    show(ready);
    expect(screen.queryByTestId("browser-starting")).toBeNull();
    expect(screen.queryByTestId("browser-stopped")).toBeNull();
  });

  it("says plainly that there is no Chrome, with nothing to press", () => {
    show({ ...ready, phase: "unavailable", message: "Google Chrome is not installed" });
    expect(screen.getByTestId("browser-stopped").textContent).toContain("Google Chrome is not installed");
    expect(screen.queryByRole("button", { name: "Relaunch Chrome" })).toBeNull();
  });

  it("offers a relaunch after a crash", () => {
    show({ ...ready, phase: "crashed", message: "Chrome stopped unexpectedly." });
    fireEvent.click(screen.getByRole("button", { name: "Relaunch Chrome" }));
    expect(api.relaunch).toHaveBeenCalledTimes(1);
  });
});

describe("dialogs", () => {
  const dialog = (kind: string, over = {}) => ({ id: "7", kind, message: "<b>hello</b>", defaultPrompt: "", origin: "https://example.com", ...over });

  it("names the origin and shows the page's words as text", () => {
    show({ ...ready, dialog: dialog("alert") });
    expect(screen.getByRole("dialog").textContent).toContain("https://example.com says");
    expect(screen.getByTestId("browser-dialog-message").textContent).toBe("<b>hello</b>");
    expect(screen.getByTestId("browser-dialog-message").querySelector("b")).toBeNull();
  });

  it("an alert has only OK", () => {
    show({ ...ready, dialog: dialog("alert") });
    expect(screen.queryByRole("button", { name: "Cancel" })).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "OK" }));
    expect(api.dialog).toHaveBeenCalledWith("thread:t1", "7", true, "");
  });

  it("a confirm can be refused", () => {
    show({ ...ready, dialog: dialog("confirm") });
    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
    expect(api.dialog).toHaveBeenCalledWith("thread:t1", "7", false, "");
  });

  it("a prompt takes text, by button or Enter", () => {
    show({ ...ready, dialog: dialog("prompt", { defaultPrompt: "Ada" }) });
    const input = screen.getByRole("textbox", { name: "Answer" });
    expect((input as HTMLInputElement).value).toBe("Ada");
    fireEvent.change(input, { target: { value: "Grace" } });
    fireEvent.keyDown(input, { key: "Enter" });
    expect(api.dialog).toHaveBeenCalledWith("thread:t1", "7", true, "Grace");
  });

  it("beforeunload speaks for itself, not in the page's words", () => {
    show({ ...ready, dialog: dialog("beforeunload", { message: "Your account is at risk" }) });
    expect(screen.getByTestId("browser-dialog-message").textContent).not.toContain("risk");
    fireEvent.click(screen.getByRole("button", { name: "Stay" }));
    expect(api.dialog).toHaveBeenCalledWith("thread:t1", "7", false, "");
  });
});

describe("file choosers", () => {
  const chooser = { id: "8", multiple: false, origin: "https://example.com" };

  it("says who asks, and that the files go to the site", () => {
    show({ ...ready, fileChooser: chooser });
    expect(screen.getByRole("dialog").textContent).toContain("https://example.com asks for a file");
    expect(screen.getByRole("dialog").textContent).toContain("goes to the site");
  });

  it("gives one file to a single input", async () => {
    show({ ...ready, fileChooser: chooser });
    fireEvent.click(screen.getByRole("button", { name: "Choose…" }));
    await vi.waitFor(() => {
      expect(api.files).toHaveBeenCalledWith("thread:t1", "8", ["/Users/me/a.txt"]);
    });
  });

  it("gives all to a multiple one", async () => {
    show({ ...ready, fileChooser: { ...chooser, multiple: true } });
    fireEvent.click(screen.getByRole("button", { name: "Choose…" }));
    await vi.waitFor(() => {
      expect(api.files).toHaveBeenCalledWith("thread:t1", "8", ["/Users/me/a.txt", "/Users/me/b.txt"]);
    });
  });

  it("can be cancelled", () => {
    show({ ...ready, fileChooser: chooser });
    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
    expect(api.files).toHaveBeenCalledWith("thread:t1", "8", []);
  });

  it("says so without the app's window", async () => {
    api.pick.mockResolvedValueOnce(null);
    show({ ...ready, fileChooser: chooser });
    fireEvent.click(screen.getByRole("button", { name: "Choose…" }));
    await screen.findByText("Choosing files needs the app's window.");
    expect(api.files).not.toHaveBeenCalled();
  });
});

describe("select", () => {
  const select = {
    id: "9",
    selected: 1,
    x: 10,
    y: 40,
    width: 200,
    options: [
      { label: "one", disabled: false },
      { label: "two", disabled: false },
      { label: "three", disabled: true },
    ],
  };
  beforeEach(() => {
    Element.prototype.scrollIntoView = vi.fn();
  });

  it("lists the options under the control and marks the current one", () => {
    show({ ...ready, select });
    const list = screen.getByTestId("browser-select");
    expect(list.style.left).toBe("10px");
    expect(list.style.top).toBe("40px");
    expect(within(list).getAllByRole("option").map((o) => o.getAttribute("aria-selected"))).toEqual(["false", "true", "false"]);
  });

  it("picks, and a disabled row cannot be", () => {
    show({ ...ready, select });
    fireEvent.click(screen.getByRole("button", { name: "three" }));
    expect(api.select).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "one" }));
    expect(api.select).toHaveBeenCalledWith("thread:t1", "9", 0);
  });

  it("closes without a pick on Escape or a press outside", () => {
    const { unmount } = show({ ...ready, select });
    fireEvent.keyDown(screen.getByTestId("browser-select"), { key: "Escape" });
    expect(api.select).toHaveBeenLastCalledWith("thread:t1", "9", -1);
    unmount();
    api.select.mockClear();
    show({ ...ready, select });
    fireEvent.pointerDown(screen.getByTestId("browser-select-backdrop"));
    expect(api.select).toHaveBeenLastCalledWith("thread:t1", "9", -1);
  });
});

describe("strips", () => {
  it("shows a call's error and lets it go", () => {
    const { dismiss } = show(ready, "not an http or https address");
    expect(screen.getByTestId("browser-strip").textContent).toContain("not an http or https address");
    fireEvent.click(screen.getByRole("button", { name: "Dismiss" }));
    expect(dismiss).toHaveBeenCalledTimes(1);
  });

  it("says when the stream is lost, so a stale frame does not pass for the page", () => {
    render(<BrowserOverlays surface="thread:t1" state={ready} error="" offline scale={{ x: 1, y: 1 }} onDismissError={vi.fn()} />);
    expect(screen.getByTestId("browser-strip").textContent).toContain("Reconnecting");
  });

  it("shows the surface's notice", () => {
    show({ ...ready, notice: "This page crashed. Reload to try again." });
    expect(screen.getByTestId("browser-strip").textContent).toContain("crashed");
  });

  it("says when a page copied text, and moves it only when asked", async () => {
    const { rerender } = show(ready);
    expect(screen.queryByText("The page copied text.")).toBeNull();
    rerender(<BrowserOverlays surface="thread:t1" state={{ ...ready, copied: 1 }} error="" scale={{ x: 1, y: 1 }} onDismissError={vi.fn()} />);
    expect(api.copy).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "Copy to clipboard" }));
    expect(api.copy).toHaveBeenCalledWith("thread:t1");
    await vi.waitFor(() => {
      expect(screen.queryByText("The page copied text.")).toBeNull();
    });
  });

  it("follows a download and offers Finder when it is done", () => {
    const { rerender } = show({ ...ready, downloads: [{ id: "g", name: "report.pdf", state: "inProgress" }] });
    expect(screen.getByText("report.pdf")).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Show in Finder" })).toBeNull();
    rerender(<BrowserOverlays surface="thread:t1" state={{ ...ready, downloads: [{ id: "g", name: "report.pdf", state: "completed" }] }} error="" scale={{ x: 1, y: 1 }} onDismissError={vi.fn()} />);
    fireEvent.click(screen.getByRole("button", { name: "Show in Finder" }));
    expect(api.reveal).toHaveBeenCalledWith("thread:t1", "g");
    fireEvent.click(screen.getByRole("button", { name: "Clear" }));
    expect(screen.queryByText("report.pdf")).toBeNull();
  });
});
