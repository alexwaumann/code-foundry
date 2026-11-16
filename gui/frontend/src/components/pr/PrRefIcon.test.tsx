/**
 * A pull request's state icon where only the pull request is named (its tab, the Open ▸
 * menu): the state's icon and colour from what is already loaded, the plain muted one before.
 */
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { PullRequestDetailView, PullRequestView } from "@/api/gh";
import { shellSurfaceOf } from "@/shell/surfaces/registry";
import { dashboardResource, pullRequestDetailResource, pullRequestKey } from "@/stores/gh";
import type { TabEntry } from "@/stores/layout";
import { PrRefIcon } from "./PrRefIcon";

const SLUG = "o/r";
const pr = (number: number, state: PullRequestView["state"], draft = false) => ({ repoSlug: SLUG, number, state, draft, title: "", updatedAtMs: 1, partial: false }) as PullRequestView;
const load = (p: PullRequestView) => {
  pullRequestDetailResource.set(pullRequestKey(SLUG, p.number), { data: { pullRequest: p } as PullRequestDetailView });
};
const icon = () => screen.getByTestId("pr-ref-icon");

beforeEach(() => {
  pullRequestDetailResource.store.setState({ entries: {} });
  dashboardResource.store.setState({ entries: {} });
});
afterEach(cleanup);

describe("PrRefIcon", () => {
  it.each([
    ["open", pr(1, "open"), "lucide-git-pull-request", "text-cf-success-text"],
    ["draft", pr(1, "open", true), "lucide-git-pull-request-draft", "text-cf-text-muted"],
    ["merged", pr(1, "merged"), "lucide-git-merge", "text-cf-highlight-text"],
    ["closed", pr(1, "closed"), "lucide-git-pull-request-closed", "text-cf-error-text"],
  ])("%s: its icon in its colour", (state, p, glyph, colour) => {
    load(p);
    render(<PrRefIcon slug={SLUG} number={1} className="size-3.5" />);
    expect(icon().getAttribute("data-state")).toBe(state);
    expect(icon().classList.contains(glyph)).toBe(true);
    expect(icon().classList.contains(colour)).toBe(true);
    expect(icon().classList.contains("size-3.5")).toBe(true);
  });

  it("not loaded yet: the plain icon, muted", () => {
    render(<PrRefIcon slug={SLUG} number={2} />);
    expect(icon().getAttribute("data-state")).toBe("unknown");
    expect(icon().classList.contains("lucide-git-pull-request")).toBe(true);
    expect(icon().classList.contains("text-cf-text-muted")).toBe(true);
  });

  it("is a pull request tab's icon in the shell", () => {
    load(pr(7, "merged"));
    const TabIcon = shellSurfaceOf("pullrequest").TabIcon;
    if (!TabIcon) throw new Error("no TabIcon");
    const tab = { id: "t-1", kind: "pullrequest", thread: "", key: "", params: { slug: SLUG, number: "7" }, title: "#7", name: "", preview: false, paneId: "p-1" } as TabEntry;
    render(<TabIcon tab={tab} className="size-3.5 shrink-0" />);
    expect(icon().getAttribute("data-state")).toBe("merged");
  });
});
