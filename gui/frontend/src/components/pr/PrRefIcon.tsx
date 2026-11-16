import { useMemo } from "react";
import { prStateLook } from "@/components/prs/prState";
import { useLinkedPrViews } from "@/components/sidebar/useLinkedPrs";
import { cn } from "@/lib/utils";
import type { Tab } from "@/shell/host";
import { pullRequestKey } from "@/stores/gh";
import { prRefOfTab } from "@/surfaces/pullrequestTarget";
import { prStateText } from "./tones";

/**
 * A pull request's state icon in the state's colour (open green, draft muted, merged violet,
 * closed red), as the sidebar's tag and the Pull Requests page draw it, for somewhere that
 * only names the pull request: a tab, a menu item. It reads nothing: the state is the
 * freshest of what the GUI already holds (its detail, the dashboard, a branch's list on
 * screen), and until one has it the icon is the plain muted one. `className` sizes it; the
 * colour is always the state's.
 */
export function PrRefIcon({ slug, number, className }: { slug: string; number: number; className?: string }) {
  const keys = useMemo(() => [pullRequestKey(slug, number)], [slug, number]);
  const pr = useLinkedPrViews(keys)[0] ?? null;
  const look = prStateLook(pr?.state ?? null, pr?.draft ?? false);
  const Icon = look.icon;
  return <Icon className={cn(className, prStateText[look.tone])} aria-hidden data-testid="pr-ref-icon" data-state={look.label} />;
}

/** A pull request tab's icon (SurfaceSpec.TabIcon): its state's. */
export function PullRequestTabIcon({ tab, className }: { tab: Tab; className?: string }) {
  const ref = prRefOfTab(tab);
  return <PrRefIcon slug={ref?.slug ?? ""} number={ref?.number ?? 0} className={className} />;
}
