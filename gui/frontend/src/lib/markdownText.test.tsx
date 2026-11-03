import { cleanup, render } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { markdownText } from "./markdownText";

vi.mock("@/stores/gh", () => ({ openUrl: vi.fn(() => Promise.resolve()) }));
vi.mock("@/api/threads", () => ({ readAttachment: vi.fn(() => Promise.resolve(null)) }));

const { ThreadMarkdown } = await import("@/components/thread/Code");
const { plainText } = await import("@/components/thread/cite/citeDom");

afterEach(cleanup);

/** What the cite layer reads from the rendered answer (TextRow's element). */
function rendered(md: string): string {
  const { container } = render(<ThreadMarkdown>{md}</ThreadMarkdown>);
  return plainText(container).text;
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
];

describe("markdownText", () => {
  it.each(cases)("%s: the text the thread renders", (_name, md) => {
    expect(markdownText(md)).toBe(rendered(md));
  });

  it("is empty for empty markdown", () => {
    expect(markdownText("")).toBe("");
  });
});
