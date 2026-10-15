import { describe, expect, it } from "vitest";
import { composerKeyAction } from "./keys";
import { canSubmit, composerHint, disabledVerdicts, REVIEW_KEYS_HINT, REVIEW_SENDING_HINT, reviewArgs, reviewVisible, VERDICT_SPECS, yourReview, type Verdict } from "./review";

describe("VERDICT_SPECS", () => {
  it.each([
    ["approve", "Approve", "Approve #139", "success", false],
    ["request-changes", "Request changes", "Request changes on #139", "failure", true],
    ["comment", "Comment", "Comment on #139", "neutral", true],
  ] as const)("%s → %s, %s, %s tone, body required %s", (v, title, label, tone, required) => {
    const s = VERDICT_SPECS[v];
    expect(s.title).toBe(title);
    expect(s.label(139)).toBe(label);
    expect(s.tone).toBe(tone);
    expect(s.bodyRequired).toBe(required);
  });
});

describe("canSubmit and composerHint", () => {
  it.each([
    ["approve", "", false, true, REVIEW_KEYS_HINT],
    ["approve", "  ", false, true, REVIEW_KEYS_HINT],
    ["request-changes", "", false, false, "Say what should change"],
    ["request-changes", " \n ", false, false, "Say what should change"],
    ["request-changes", "Rename it", false, true, REVIEW_KEYS_HINT],
    ["comment", "", false, false, "Write a comment"],
    ["comment", "Nice", false, true, REVIEW_KEYS_HINT],
    ["comment", "Nice", true, true, REVIEW_SENDING_HINT],
  ] as [Verdict, string, boolean, boolean, string][])("%s %j (sending %s) → submit %s, hint %s", (v, text, sending, ok, hint) => {
    expect(canSubmit(v, text)).toBe(ok);
    expect(composerHint(v, text, sending)).toBe(hint);
  });
});

describe("disabledVerdicts", () => {
  it("own pull request (logins compared case-insensitively): approve and request changes, with the reason", () => {
    expect(disabledVerdicts("AlexWaumann", "alexwaumann")).toEqual({
      approve: "You cannot approve your own pull request.",
      "request-changes": "Not on your own pull request.",
    });
  });
  it.each([
    ["teammate-kim", "alexwaumann"],
    ["alexwaumann", ""], // the viewer is not known yet: GitHub decides
    ["", ""],
  ])("%j by %j: none", (author, viewer) => {
    expect(disabledVerdicts(author, viewer)).toEqual({});
  });
});

describe("reviewVisible", () => {
  it.each([
    [true, "open", true],
    [false, "open", false],
    [true, "merged", false],
    [true, "closed", false],
  ] as const)("write %s, %s → %s", (viewerCanUpdate, state, want) => {
    expect(reviewVisible({ viewerCanUpdate, pullRequest: { state } })).toBe(want);
  });
});

describe("yourReview", () => {
  const r = (login: string, state: string, isTeam = false) => ({ login, state, isTeam }) as Parameters<typeof yourReview>[0][number];
  it.each([
    [[r("alexwaumann", "approved")], "approved"],
    [[r("teammate-kim", "approved"), r("AlexWaumann", "changes_requested")], "changes_requested"],
    [[r("alexwaumann", "commented")], "commented"],
    // Only requested, a pending (unsubmitted) review, a dismissed one: Review again.
    [[r("alexwaumann", "")], null],
    [[r("alexwaumann", "pending")], null],
    [[r("alexwaumann", "dismissed")], null],
    [[r("teammate-kim", "approved")], null],
    [[r("alexwaumann", "approved", true)], null],
    [[], null],
  ] as const)("%j → %s", (reviewers, want) => {
    expect(yourReview(reviewers, "alexwaumann")).toBe(want);
  });
  it("an unknown viewer has no review", () => {
    expect(yourReview([r("", "approved")], "")).toBeNull();
  });
});

describe("reviewArgs", () => {
  it("trims the body and leaves an empty one out", () => {
    expect(reviewArgs({ slug: "o/r", number: 7 }, "request-changes", "  Fix it\n")).toEqual({ "repo-slug": "o/r", number: "7", verdict: "request-changes", body: "Fix it" });
    expect(reviewArgs({ slug: "o/r", number: 7 }, "approve", " \n")).toEqual({ "repo-slug": "o/r", number: "7", verdict: "approve" });
  });
});

describe("composerKeyAction, cmd-enter (the review composer)", () => {
  it.each([
    [{ key: "Enter", shiftKey: false, metaKey: true }, "send"],
    [{ key: "Enter", shiftKey: false }, null],
    [{ key: "Enter", shiftKey: true }, null],
    [{ key: "Enter", shiftKey: true, metaKey: true }, null],
    [{ key: "Enter", shiftKey: false, metaKey: true, ctrlKey: true }, null],
    [{ key: "Enter", shiftKey: false, metaKey: true, altKey: true }, null],
    [{ key: "Enter", shiftKey: false, metaKey: true, isComposing: true }, null],
    [{ key: "Enter", shiftKey: false, metaKey: true, keyCode: 229 }, null],
    [{ key: "Escape", shiftKey: false }, "cancel"],
    [{ key: "Escape", shiftKey: false, isComposing: true }, null],
    [{ key: "a", shiftKey: false, metaKey: true }, null],
  ] as const)("%j → %s", (e, want) => {
    expect(composerKeyAction(e, "cmd-enter")).toBe(want);
  });
});
