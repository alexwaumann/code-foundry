import { describe, expect, it } from "vitest";
import { DRAFT_LABEL_MAX, draftLabel } from "./draftLabel";
import { tagToken } from "./prompt";

describe("draftLabel", () => {
  it("is the first line with text, whitespace collapsed", () => {
    expect(draftLabel("  Fix the  sidebar\nand more")).toBe("Fix the sidebar");
    expect(draftLabel("\n   \nSecond   line")).toBe("Second line");
  });

  it("is empty without text", () => {
    expect(draftLabel("")).toBe("");
    expect(draftLabel("   \n  ")).toBe("");
  });

  it("names tags by their labels", () => {
    const skill = tagToken({ tagKind: "skill", name: "review", projectId: "" });
    expect(draftLabel(`Run ${skill} on it`)).toBe("Run /review on it");
  });

  it("is cut with an ellipsis past its length", () => {
    const long = "word ".repeat(40);
    const label = draftLabel(long);
    expect(label.length).toBe(DRAFT_LABEL_MAX);
    expect(label.endsWith("…")).toBe(true);
  });
});
