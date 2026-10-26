import { describe, expect, it } from "vitest";
import type { PullRequestView } from "@/api/gh";
import type { AuthoredRow, AuthoredStatusKind } from "./authoredStatus";
import { emberLine } from "./emberLine";

const row = (number: number, kind: AuthoredStatusKind, reviewRequests: string[] = []): AuthoredRow =>
  ({ pr: { number, reviewRequests } as unknown as PullRequestView, status: { kind, label: "", tone: "neutral", rank: 0 } }) as AuthoredRow;
const merged = (author: string) => ({ author }) as PullRequestView;

// 2026-10-26 is day 299 (299 % 3 = 2); the 27th is day 300 (0).
const MON = new Date(2026, 9, 26, 9);
const TUE = new Date(2026, 9, 27, 9);

describe("emberLine", () => {
  it.each<[string, AuthoredRow[], PullRequestView[], Date, string]>([
    ["one ready", [row(5, "ci_failing"), row(42, "ready")], [], MON, "The forge is quiet. #42 is approved and green, want to ship it?"],
    ["several ready", [row(1, "ready"), row(2, "ready"), row(3, "ready")], [], MON, "Three of yours are approved and green, want to ship them?"],
    ["one broken", [row(1, "conflicts"), row(2, "awaiting_review", ["kim"])], [], MON, "Nothing to review. One of yours needs a hand, though."],
    ["two broken", [row(1, "conflicts"), row(2, "ci_failing")], [], MON, "Nothing to review. Two of yours need a hand, though."],
    ["one reviewer owed", [row(1, "awaiting_review", ["kim"]), row(2, "awaiting_review", ["Kim"])], [], MON, "Nothing to review. A teammate still owes you a review."],
    ["several reviewers owed", [row(1, "awaiting_review", ["kim", "acme/core"]), row(2, "awaiting_review", ["ana"])], [], MON, "Nothing to review. Three teammates still owe you a review."],
    ["merged this week", [row(1, "draft")], [merged("Me"), merged("kim"), merged("me")], MON, "Quiet queue. You merged two this week."],
    ["many merged", [], Array.from({ length: 12 }, () => merged("me")), MON, "Quiet queue. You merged 12 this week."],
    ["quiet, by day", [], [merged("kim")], MON, "The forge is quiet. Nothing is waiting on you."],
    ["quiet, the next day", [], [], TUE, "Inbox zero. Enjoy it while it lasts."],
  ])("%s", (_name, authored, mergedList, now, want) => {
    expect(emberLine(authored, mergedList, "me", now)).toBe(want);
  });

  it("no viewer: merges are not the viewer's", () => {
    expect(emberLine([], [merged("me")], "", MON)).toBe("The forge is quiet. Nothing is waiting on you.");
  });
});
