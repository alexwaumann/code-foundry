import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { BROWSER_STARTING, type BrowserStateView } from "@/api/browser";
import { TooltipProvider } from "@/components/ui/tooltip";

const navigated = vi.hoisted(() => ({ finish: () => {}, fail: (_: unknown) => {} }));
vi.mock("@/api/browser", async (actual) => ({
  ...(await actual<typeof import("@/api/browser")>()),
  navigateBrowser: () =>
    new Promise<void>((resolve, reject) => {
      navigated.finish = resolve;
      navigated.fail = reject;
    }),
}));

const { BrowserToolbar } = await import("./BrowserToolbar");

const ready: BrowserStateView = { ...BROWSER_STARTING, phase: "ready" };

function show(state: Partial<BrowserStateView>, onLeave = vi.fn()) {
  return render(
    <TooltipProvider>
      <textarea data-testid="composer" />
      <BrowserToolbar surface="thread:t1" state={{ ...ready, ...state }} onLeave={onLeave} />
    </TooltipProvider>,
  );
}

afterEach(cleanup);

describe("the bar's address", () => {
  it("shows the registrable domain apart from what can clip", () => {
    show({ url: "https://login.bank.example.com.evil.co/signin", origin: "https://login.bank.example.com.evil.co", site: "evil.co" });
    expect(screen.getByTestId("browser-address-site").textContent).toBe("evil.co");
    expect(screen.getByTestId("browser-address-shown").textContent).toBe("https://login.bank.example.com.evil.co/signin");
  });

  it("gives the whole address to whoever edits it", () => {
    show({ url: "https://www.example.com/a", origin: "https://www.example.com", site: "example.com" });
    const input = screen.getByTestId<HTMLInputElement>("browser-address");
    fireEvent.focus(input);
    expect(screen.queryByTestId("browser-address-shown")).toBeNull();
    expect(input.value).toBe("https://www.example.com/a");
    fireEvent.blur(input);
    expect(screen.getByTestId("browser-address-shown")).toBeTruthy();
  });

  it("is empty on the blank page a surface starts on", () => {
    show({ url: "about:blank" });
    expect(screen.getByTestId<HTMLInputElement>("browser-address").value).toBe("");
  });

  it("names about:blank in a popup, which an opener can write into", () => {
    show({ url: "about:blank", popup: true, security: "insecure" });
    expect(screen.getByTestId<HTMLInputElement>("browser-address").value).toBe("about:blank");
    expect(screen.getByTestId("browser-security").textContent).toBe("Not secure");
  });

  it("names who wrote a blank page, and marks it", () => {
    show({ url: "about:blank", origin: "http://evil.test", site: "evil.test", security: "insecure" });
    expect(screen.getByTestId("browser-address-site").textContent).toBe("evil.test");
    expect(screen.getByTestId("browser-address-shown").textContent).toContain("about:blank");
    expect(screen.getByTestId("browser-security").textContent).toBe("Not secure");
  });

  it("keeps the site in view when the address is nothing a parser takes", () => {
    show({ url: "http://evil.test:81/%zz", origin: "http://evil.test:81", site: "evil.test", security: "insecure" });
    expect(screen.getByTestId("browser-address-site").textContent).toBe("evil.test:81");
  });

  it("says it cannot tell who a page with no origin is", () => {
    show({ url: "data:text/html,hi", security: "insecure" });
    expect(screen.getByTestId("browser-address-site").textContent).toBe("Unknown site");
  });
});

describe("Enter on an address", () => {
  beforeEach(() => {
    navigated.finish = () => {};
  });

  function enter(onLeave: () => void) {
    show({ url: "http://a.example/", origin: "http://a.example", site: "a.example" }, vi.fn(onLeave));
    const input = screen.getByTestId<HTMLInputElement>("browser-address");
    input.focus();
    fireEvent.change(input, { target: { value: "slow.example" } });
    fireEvent.keyDown(input, { key: "Enter" });
    return input;
  }

  it("gives the keyboard to the page once the address answers", async () => {
    const onLeave = vi.fn();
    enter(onLeave);
    await act(async () => {
      navigated.finish();
      await Promise.resolve();
    });
    expect(onLeave).toHaveBeenCalledTimes(1);
  });

  it("leaves it alone if the user went elsewhere while the server held the first byte", async () => {
    const onLeave = vi.fn();
    enter(onLeave);
    const composer = screen.getByTestId("composer");
    composer.focus();
    await act(async () => {
      navigated.finish();
      await Promise.resolve();
    });
    expect(onLeave).not.toHaveBeenCalled();
    expect(document.activeElement).toBe(composer);
  });
});

describe("the security mark", () => {
  it.each([
    ["insecure" as const, "Not secure"],
    ["cert" as const, "Bad certificate"],
  ])("says %s out loud", (security, words) => {
    show({ url: "http://example.com/", origin: "http://example.com", site: "example.com", security });
    expect(screen.getByTestId("browser-security").textContent).toBe(words);
  });

  it("is not there for a good page", () => {
    show({ url: "https://example.com/", origin: "https://example.com", site: "example.com" });
    expect(screen.queryByTestId("browser-security")).toBeNull();
  });
});
