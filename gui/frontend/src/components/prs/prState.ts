import { GitMerge, GitPullRequest, GitPullRequestClosed, GitPullRequestDraft, type LucideIcon } from "lucide-react";
import type { PrStateView } from "@/api/gh";

export type PrStateTone = "emerald" | "violet" | "red" | "muted";

export interface PrStateLook {
  icon: LucideIcon;
  tone: PrStateTone;
  /** "open", "draft", "merged", "closed"; "unknown" until the state is known. */
  label: string;
}

/**
 * A pull request's state as an icon and a tone: open emerald, merged violet, closed red,
 * draft muted; an unknown state (not loaded yet, or GitHub did not say) muted.
 */
export function prStateLook(state: PrStateView | null, draft: boolean): PrStateLook {
  if (state === "merged") return { icon: GitMerge, tone: "violet", label: "merged" };
  if (state === "closed") return { icon: GitPullRequestClosed, tone: "red", label: "closed" };
  if (state === "open" && draft) return { icon: GitPullRequestDraft, tone: "muted", label: "draft" };
  if (state === "open") return { icon: GitPullRequest, tone: "emerald", label: "open" };
  return { icon: GitPullRequest, tone: "muted", label: "unknown" };
}
