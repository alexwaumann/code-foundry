import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { BROWSER_STARTING, type BrowserStateView } from "@/api/browser";
import { TooltipProvider } from "@/components/ui/tooltip";

const { BrowserToolbar } = await import("./BrowserToolbar");

const ready: BrowserStateView = { ...BROWSER_STARTING, phase: "ready" };

function show(state: Partial<BrowserStateView>) {
  return render(
    <TooltipProvider>
      <BrowserToolbar surface="thread:t1" state={{ ...ready, ...state }} onLeave={vi.fn()} />
    </TooltipProvider>,
  );
}

afterEach(cleanup);

describe("the bar's address", () => {
  it("shows the registrable domain apart from what can clip", () => {
    show({ url: "https://login.bank.example.com.evil.co/signin", site: "evil.co" });
    expect(screen.getByTestId("browser-address-site").textContent).toBe("evil.co");
    expect(screen.getByTestId("browser-address-shown").textContent).toBe("https://login.bank.example.com.evil.co/signin");
  });

  it("gives the whole address to whoever edits it", () => {
    show({ url: "https://www.example.com/a", site: "example.com" });
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
});

describe("the security mark", () => {
  it.each([
    ["insecure" as const, "Not secure"],
    ["cert" as const, "Bad certificate"],
  ])("says %s out loud", (security, words) => {
    show({ url: "http://example.com/", site: "example.com", security });
    expect(screen.getByTestId("browser-security").textContent).toBe(words);
  });

  it("is not there for a good page", () => {
    show({ url: "https://example.com/", site: "example.com" });
    expect(screen.queryByTestId("browser-security")).toBeNull();
  });
});
