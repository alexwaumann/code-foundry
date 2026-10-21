import { cleanup, render } from "@testing-library/react";
import type { ComponentProps } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";

// Counts react-markdown parses (one per ReactMarkdown render) by the source each got.
const parsed = vi.hoisted(() => [] as string[]);
vi.mock("react-markdown", async (orig) => {
  const mod = await orig<typeof import("react-markdown")>();
  const Real = mod.default;
  return {
    ...mod,
    default: (props: ComponentProps<typeof Real>) => {
      parsed.push(props.children ?? "");
      return <Real {...props} />;
    },
  };
});

const { StreamingMarkdown, ThreadMarkdown } = await import("./Code");

afterEach(() => {
  cleanup();
  parsed.length = 0;
});

const answer = [
  "# Plan",
  "",
  "Some **bold** text with `code` and a [link](https://example.com).",
  "",
  "```sh",
  "ls",
  "",
  "pwd",
  "```",
  "",
  "- one",
  "- two",
  "",
  "  continued",
  "",
  "| a | b |",
  "|---|---|",
  "| 1 | 2 |",
  "",
  "> quoted",
  "",
  "1. first",
  "",
  "2. second",
  "",
  "Done.",
].join("\n");

describe("StreamingMarkdown", () => {
  it("renders the same elements as a whole render", () => {
    // Whole renders keep react-markdown's newline text nodes between blocks; inert in layout.
    const html = (el: Element | null | undefined) => el?.innerHTML.replace(/>\s+</g, "><");
    const whole = html(render(<ThreadMarkdown>{answer}</ThreadMarkdown>).container.firstElementChild);
    cleanup();
    const streamed = render(<StreamingMarkdown text={answer} threadId="s" />).container.firstElementChild;
    expect(streamed?.className).toContain("cf-streaming");
    expect(html(streamed)).toBe(whole);
  });

  it("a delta re-parses only the last block", () => {
    const head = answer.slice(0, answer.indexOf("Done."));
    const { rerender } = render(<StreamingMarkdown text={`${head}Do`} threadId="s" />);
    const first = parsed.length;
    expect(first).toBeGreaterThan(3);
    parsed.length = 0;
    rerender(<StreamingMarkdown text={`${head}Done.`} threadId="s" />);
    expect(parsed).toEqual(["Done."]);
  });
});
