import { describe, expect, it } from "vitest";
import { buildToc, guideBody, guideMarkdown, guideToc } from "./guide";

describe("buildToc", () => {
  it.each([
    ["h2 and h3 in order, h1 and h4 left out", "# T\n## A\ntext\n### B\n#### C\n## D", [{ level: 2, title: "A" }, { level: 3, title: "B" }, { level: 2, title: "D" }]],
    ["inline markdown and closing hashes stripped", "## **Bold** and `code` ##\n### A [link](https://x.y)", [{ level: 2, title: "Bold and code" }, { level: 3, title: "A link" }]],
    ["headings inside fenced code are not headings", "```sh\n## not this\n```\n~~~\n### nor this\n~~~\n## Yes", [{ level: 2, title: "Yes" }]],
    ["a longer fence is closed only by one as long", "````\n```\n## inside\n````\n## After", [{ level: 2, title: "After" }]],
    ["headings inside an HTML comment are skipped", "<!--\n## hidden\n-->\n## Shown", [{ level: 2, title: "Shown" }]],
    ["a hash without a space is text", "##Nope\n#hashtag\n## Yes", [{ level: 2, title: "Yes" }]],
    ["up to three spaces of indent", "   ## Indented\n    ## Code block", [{ level: 2, title: "Indented" }]],
  ])("%s", (_name, md, want) => {
    expect(buildToc(md)).toEqual(want);
  });
});

describe("guideBody", () => {
  it("starts at the first h2, dropping the title and anything above it", () => {
    expect(guideBody("# Title\n\n<!-- note -->\n\n## First\nbody")).toBe("## First\nbody");
  });

  it("keeps a document without an h2 whole", () => {
    expect(guideBody("# Only\ntext")).toBe("# Only\ntext");
  });
});

describe("the bundled guide", () => {
  it("is docs/GETTING-STARTED.md from its Getting started section on", () => {
    expect(guideMarkdown.startsWith("## Getting started\n")).toBe(true);
    // The app's line comes first; no vendor name in it.
    expect(guideMarkdown).toContain("A single surface for all your agents.");
  });

  it("has the sections the overlay's contents list", () => {
    expect(guideToc).toEqual([
      { level: 2, title: "Getting started" },
      { level: 3, title: "Add a project" },
      { level: 3, title: "Start a thread" },
      { level: 3, title: "Where changes go" },
      { level: 3, title: "While it runs" },
      { level: 3, title: "Review and ship" },
      { level: 3, title: "Find anything" },
      { level: 2, title: "Install on another Mac" },
      { level: 2, title: "Settings" },
    ]);
  });
});
