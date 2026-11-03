import { cleanup, render } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { markdownText, streamingBlockCacheSize, streamingMarkdownText } from "./markdownText";
import renderedTextFixture from "../../../../internal/store/thread/testdata/rendered_text.json?raw";

vi.mock("@/stores/gh", () => ({ openUrl: vi.fn(() => Promise.resolve()) }));
vi.mock("@/api/threads", () => ({ readAttachment: vi.fn(() => Promise.resolve(null)) }));

const { StreamingMarkdown, ThreadMarkdown } = await import("@/components/thread/Code");
const { findText } = await import("@/components/thread/find/findDom");

afterEach(cleanup);

/** What the find layer reads from the rendered answer (TextRow's element: citeDom plainText less FIND_SKIP). */
function rendered(md: string): string {
  const { container } = render(<ThreadMarkdown>{md}</ThreadMarkdown>);
  return findText(container).text;
}

/** The same while the answer streams (StreamingMarkdown: block by block). */
function renderedStreaming(md: string): string {
  const { container } = render(<StreamingMarkdown text={md} threadId="s-1" />);
  return findText(container).text;
}

const cases: [string, string][] = [
  ["paragraphs", "The poller compared only the count.\n\nThe **fingerprint** now includes the *head SHA*."],
  ["inline code and a path chip", "Run `go test ./...` in `internal/store/pr/fingerprint.go:12` or ` spaced `."],
  ["lists", "What changed:\n\n- `Fingerprint` carries `HeadOid`\n- fills it from `pr.HeadRefOid`\n\n1. one\n2. two\n   - nested"],
  ["loose list", "- first\n\n  more of first\n\n- second"],
  ["a fenced block", "Before:\n\n```go\nfunc fingerprintOf(pr PullRequest) Fingerprint {\n\treturn Fingerprint{}\n}\n```\n\nAfter."],
  ["a table", "| Case | Before | After |\n| --- | --- | --- |\n| New commit | skipped | refreshed |\n| Force-push | skipped | refreshed |"],
  ["headings and quotes", "## Fixed: stale badge\n\n> quoted **text**\n> second line\n\n### Next"],
  ["links", "See [the docs](https://example.com), [main.go](src/main.go) and [about](about)."],
  ["html as text", "It returns Result<T, E>, <small>fine print</small> and <b>bold?</b>.\n\nline<br>break"],
  ["task list", "- [x] done\n- [ ] open"],
  ["hard breaks and rules", "one  \ntwo\n\n---\n\nthree"],
  ["an https image", "Look: ![shot](https://example.com/a.png) here"],
  ["a local image's chip", "Before ![the shot](shots/a.png) after"],
  ["a path in prose", "It lives in internal/store/pr/fingerprint.go and src/main.ts:12."],
  ["a reference link", "See [the docs][d] first.\n\n[d]: https://example.com"],
  ["a footnote", "A claim.[^1]\n\n[^1]: The source."],
];

describe("markdownText", () => {
  it.each(cases)("%s: the text the thread renders", (_name, md) => {
    expect(markdownText(md)).toBe(rendered(md));
  });

  it("is empty for empty markdown", () => {
    expect(markdownText("")).toBe("");
    expect(streamingMarkdownText("")).toBe("");
  });
});

/**
 * The rendered text fixture the daemon shares (docs/notes/search-5-agent-daemon.md): agent
 * search stores a quote as the reply reads, and the daemon's renderedText
 * (internal/store/thread/search_render.go) must read each case as markdownText does (its Go
 * test checks the same file). scripts/renderedTextFixture.ts writes the texts.
 */
const shared = (JSON.parse(renderedTextFixture) as { name: string; markdown: string; text: string }[]).map((c): [string, string, string] => [
  c.name,
  c.markdown,
  c.text,
]);

describe("the daemon's rendered text fixture", () => {
  it("has the cases", () => {
    expect(shared.length).toBeGreaterThan(50);
  });

  it.each(shared)("%s: markdownText and the thread's render read it as the fixture says", (_name, md, text) => {
    expect(markdownText(md)).toBe(text);
    expect(rendered(md)).toBe(text);
  });
});

describe("streamingMarkdownText", () => {
  it.each(cases)("%s: the text the streaming answer renders (block by block)", (_name, md) => {
    expect(streamingMarkdownText(md)).toBe(renderedStreaming(md));
  });

  it("a reference link is literal while streaming and a link once whole, as on screen", () => {
    const md = "See [the docs][d] first.\n\n[d]: https://example.com";
    expect(streamingMarkdownText(md)).toBe("See [the docs][d] first.");
    expect(markdownText(md)).toBe("See the docs first.");
  });

  it("a growing answer: each prefix reads as its render", () => {
    const md = cases.map(([, m]) => m).join("\n\n");
    for (const n of [40, 200, 420, md.length]) expect(streamingMarkdownText(md.slice(0, n))).toBe(renderedStreaming(md.slice(0, n)));
  });

  it("caches finished blocks only: a long last block streaming in many batches adds nothing per batch", () => {
    const head = "A paragraph before the code.\n\n";
    const code = "```ts\n" + Array.from({ length: 200 }, (_, i) => `const line${String(i)} = ${String(i)};`).join("\n") + "\n```";
    streamingMarkdownText(head + code.slice(0, 10));
    const size = streamingBlockCacheSize();
    for (let n = 20; n <= code.length; n += 20) streamingMarkdownText(head + code.slice(0, n));
    // The paragraph is cached once; the code block, the last one, never.
    expect(streamingBlockCacheSize()).toBe(size);
    expect(streamingMarkdownText(head + code)).toContain("const line199 = 199;");
  });
});
