/** A log node with `ansi` (pluginsdk/ui Log.ANSI): SGR spans in the theme's palette, other escapes gone, Copy without escapes. */
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { LogData } from "@/api/plugin";
import { copyText } from "@/lib/clipboard";
import { appendToLog } from "@/stores/pluginSurfaces";
import { demoView } from "@/test/pluginFixtures";
import { LogNode } from "./nodes/LogNode";

vi.mock("@/lib/clipboard", () => ({ copyText: vi.fn(() => Promise.resolve()) }));

const E = "\x1b";

function log(data: LogData) {
  return render(<LogNode node={{ key: "l", log: data }} data={data} />);
}

const rows = () => Array.from(screen.getByTestId("plugin-log-box").children).filter((el) => !el.textContent.startsWith("earlier"));

afterEach(cleanup);

describe("a log with ansi", () => {
  it("draws SGR spans in the terminal palette and drops the other escapes", () => {
    log({ ansi: true, text: `${E}[2K${E}[36m[INFO]${E}[0m Running\n${E}[1;31mFAIL${E}[0m x\n${E}]0;title\x07plain\n` });
    const [info, fail, plain] = rows();
    expect(info?.textContent).toBe("[INFO] Running");
    const cyan = info?.querySelector<HTMLElement>("[data-sgr]");
    expect(cyan?.textContent).toBe("[INFO]");
    expect(cyan?.style.color).toBe("var(--terminal-ansi-6)");
    const red = fail?.querySelector<HTMLElement>("[data-sgr]");
    expect(red?.className).toContain("font-bold");
    expect(red?.style.color).toBe("var(--terminal-ansi-1)");
    expect(plain?.textContent).toBe("plain");
    expect(plain?.querySelector("[data-sgr]")).toBeNull();
    expect(screen.getByTestId("plugin-log-box").textContent).not.toContain(E);
  });

  it("carries a style across lines and keeps line tones beneath", () => {
    log({ ansi: true, lines: [{ text: `${E}[33mwarn` }, { text: "still", tone: "error" }, { text: `${E}[0mdone`, tone: "error" }] });
    const [a, b, c] = rows();
    expect(a?.querySelector<HTMLElement>("[data-sgr]")?.style.color).toBe("var(--terminal-ansi-3)");
    expect(b?.querySelector<HTMLElement>("[data-sgr]")?.style.color).toBe("var(--terminal-ansi-3)");
    expect(c?.getAttribute("data-tone")).toBe("error");
    expect(c?.querySelector("[data-sgr]")).toBeNull();
  });

  it("copies the text without escapes", () => {
    log({ ansi: true, text: `${E}[32mok${E}[0m\n${E}[1mbold${E}[0m\n` });
    fireEvent.click(screen.getByRole("button", { name: "Copy log" }));
    expect(copyText).toHaveBeenLastCalledWith("ok\nbold");
  });

  it("follows appended text, an escape split between two appends included", () => {
    let data: LogData = { ansi: true, text: `${E}[3` };
    data = appendToLog(data, `1mred${E}[0m\n`, []);
    log(data);
    expect(rows()[0]?.querySelector<HTMLElement>("[data-sgr]")?.style.color).toBe("var(--terminal-ansi-1)");
    expect(rows()[0]?.textContent).toBe("red");
  });

  it("leaves the text as it is without ansi", () => {
    log({ text: `${E}[31mred${E}[0m\n` });
    expect(rows()[0]?.textContent).toBe(`${E}[31mred${E}[0m`);
    expect(screen.getByTestId("plugin-log-box").querySelector("[data-sgr]")).toBeNull();
  });

  it("draws the hello demo's coloured test log", () => {
    const view = demoView("log");
    const node = view.nodes.find((n) => n.key === "test-log");
    expect(node?.log?.ansi).toBe(true);
    log(node?.log as LogData);
    const text = rows().map((r) => r.textContent);
    expect(text[0]).toBe("[INFO] Running integration shards");
    expect(text.join("\n")).not.toContain(E);
    expect(screen.getByTestId("plugin-log-box").querySelectorAll("[data-sgr]").length).toBeGreaterThan(8);
  });
});
