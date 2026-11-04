import { cleanup, render } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ToolCallView } from "@/api/thread";

const fitScrollbar = vi.hoisted(() => vi.fn(() => () => undefined));
vi.mock("@/lib/scrollbarFit", () => ({ fitScrollbar }));

const { Markdown } = await import("@/components/pr/Markdown");
const { ThreadMarkdown } = await import("./Code");
const { ToolDetail } = await import("./ToolDetail");

const TABLE = "| a |\n|---|\n| 1 |\n";
const tool = (name: string, inputJson: string): ToolCallView => ({ name, inputJson, output: "out", resultJson: "" }) as ToolCallView;

/** The boxes fitScrollbar was given, as tag.class. */
const fitted = () => fitScrollbar.mock.calls.map((c: unknown[]) => c[0] as HTMLElement).map((el) => `${el.tagName.toLowerCase()}${el.className ? `.${el.className}` : ""}`);

beforeEach(() => {
  fitScrollbar.mockClear();
});
afterEach(cleanup);

/** Every box that scrolls sideways and grows with its bar (lib/scrollbarFit). */
describe("sideways-scrolling boxes fit their scrollbar", () => {
  it.each([
    ["a thread's code block and table", <ThreadMarkdown key="t">{`\`\`\`\nx\n\`\`\`\n\n${TABLE}`}</ThreadMarkdown>, ["pre", "div.cf-table"]],
    ["a PR body's code block and table", <Markdown key="p">{`\`\`\`\nx\n\`\`\`\n\n${TABLE}`}</Markdown>, ["pre", "table"]],
    ["a Bash row's output", <ToolDetail key="b" t={tool("Bash", '{"command":"ls"}')} cwd="/w" />, ["div.out"]],
    ["another tool's input and output", <ToolDetail key="o" t={tool("Other", "{}")} cwd="/w" />, ["div.out", "div.out"]],
  ])("%s", (_name, ui, boxes) => {
    render(ui);
    expect(fitted()).toEqual(boxes);
  });
});
