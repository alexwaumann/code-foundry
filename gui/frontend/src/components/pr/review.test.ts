import { describe, expect, it } from "vitest";
import { composerKeyAction } from "./keys";
import { canSubmit, disabledVerdicts, initialVerdict, REVIEW_KEYS_HINT, reviewHint, reviewRequested, reviewVisible, VERDICT_SPECS, VERDICTS, yourReview, type Verdict, type YourReview } from "./review";

describe("VERDICT_SPECS", () => {
  it.each([
    ["approve", "Approve", "Approve", "Approving…", "success", false, "Optional comment"],
    ["request-changes", "Request changes", "Request changes", "Requesting changes…", "failure", true, "What needs to change before this merges?"],
    ["comment", "Comment", "Submit comment", "Commenting…", "neutral", true, "Leave a comment"],
  ] as const)("%s → segment %s, confirm %s, busy %s, %s tone, body required %s, placeholder %s", (v, title, confirm, busy, tone, required, placeholder) => {
    const s = VERDICT_SPECS[v];
    expect([s.title, s.confirm, s.busy, s.tone, s.bodyRequired, s.placeholder]).toEqual([title, confirm, busy, tone, required, placeholder]);
  });
  it("the segmented control reads Comment | Approve | Request changes", () => {
    expect(VERDICTS).toEqual(["comment", "approve", "request-changes"]);
  });
});

describe("canSubmit and reviewHint", () => {
  it.each([
    ["approve", "", true, REVIEW_KEYS_HINT],
    ["approve", "  ", true, REVIEW_KEYS_HINT],
    ["request-changes", "", false, "Say what should change"],
    ["request-changes", " \n ", false, "Say what should change"],
    ["request-changes", "Rename it", true, REVIEW_KEYS_HINT],
    ["comment", "", false, "Write a comment"],
    ["comment", "Nice", true, REVIEW_KEYS_HINT],
  ] as [Verdict, string, boolean, string][])("%s %j → submit %s, hint %s", (v, text, ok, hint) => {
    expect(canSubmit(v, text)).toBe(ok);
    expect(reviewHint(v, text)).toBe(hint);
  });
});

describe("disabledVerdicts", () => {
  it("own pull request (logins compared case-insensitively): approve and request changes", () => {
    expect(disabledVerdicts("AlexWaumann", "alexwaumann")).toEqual(["approve", "request-changes"]);
  });
  it.each([
    ["teammate-kim", "alexwaumann"],
    ["alexwaumann", ""], // the viewer is not known yet: GitHub decides
    ["", ""],
  ])("%j by %j: none", (author, viewer) => {
    expect(disabledVerdicts(author, viewer)).toEqual([]);
  });
});

describe("initialVerdict", () => {
  const own = ["approve", "request-changes"] as const;
  it.each([
    { name: "someone else's, no review yet", draft: null, mine: null, disabled: [], want: "approve" },
    { name: "own, no review yet", draft: null, mine: null, disabled: own, want: "comment" },
    { name: "reopened from You requested changes", draft: null, mine: "changes_requested", disabled: [], want: "request-changes" },
    { name: "reopened from You commented", draft: null, mine: "commented", disabled: [], want: "comment" },
    { name: "an unsent draft wins over the chip", draft: "comment", mine: "approved", disabled: [], want: "comment" },
    { name: "a draft GitHub would refuse now falls back", draft: "approve", mine: null, disabled: own, want: "comment" },
    { name: "own, a previous approval cannot be repeated", draft: null, mine: "approved", disabled: own, want: "comment" },
  ] as { name: string; draft: Verdict | null; mine: YourReview | null; disabled: readonly Verdict[]; want: Verdict }[])("$name → $want", ({ draft, mine, disabled, want }) => {
    expect(initialVerdict(draft, mine, disabled)).toBe(want);
  });
});

describe("reviewRequested", () => {
  it.each([
    [[{ login: "Me", isTeam: false, requested: true }], true],
    [[{ login: "me", isTeam: false, requested: false }], false],
    [[{ login: "me", isTeam: true, requested: true }], false],
    [[{ login: "kim", isTeam: false, requested: true }], false],
    [[], false],
  ] as const)("%j → %s", (reviewers, want) => {
    expect(reviewRequested(reviewers, "me")).toBe(want);
  });
});

describe("reviewVisible", () => {
  const asked = (login: string, isTeam = false) => ({ login, isTeam, requested: true });
  it.each([
    { name: "write, open", write: true, state: "open", reviewers: [], want: true },
    { name: "read, open", write: false, state: "open", reviewers: [], want: false },
    { name: "write, merged", write: true, state: "merged", reviewers: [], want: false },
    { name: "write, closed", write: true, state: "closed", reviewers: [], want: false },
    { name: "read, the viewer's review requested", write: false, state: "open", reviewers: [asked("Me")], want: true },
    { name: "read, someone else's requested", write: false, state: "open", reviewers: [asked("kim")], want: false },
    { name: "read, a team's requested (membership unknown)", write: false, state: "open", reviewers: [asked("me", true)], want: false },
    { name: "read, requested, but merged", write: false, state: "merged", reviewers: [asked("me")], want: false },
  ] as const)("$name → $want", ({ write, state, reviewers, want }) => {
    expect(reviewVisible({ viewerCanUpdate: write, pullRequest: { state }, reviewers }, "me")).toBe(want);
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

describe("composerKeyAction, cmd-enter (the review dialog)", () => {
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
