import type { ReactNode } from "react";
import { DialogDescription, DialogTitle } from "@/components/ui/dialog";
import { Tip } from "@/components/ui/tooltip";
import { RepoRef } from "./RepoRef";

/**
 * The merge and review dialogs' heading: `badge` (the action's icon in its tone), then
 * `heading`, the action, as the title ("Squash and merge", "Review"), a quiet owner/repo #number in the page
 * header's form, and the pull request's title (the description). `testId` prefixes each
 * line's test id: `-title`, `-repo`, `-pr-title`.
 */
export function PrDialogHeading({ badge, heading, slug, number, prTitle, testId }: { badge: ReactNode; heading: string; slug: string; number: number; prTitle: string; testId: string }) {
  const repo = `${slug} #${String(number)}`;
  return (
    <div className="flex items-center gap-3">
      {badge}
      <div className="flex min-w-0 flex-col">
        <DialogTitle data-testid={`${testId}-title`}>{heading}</DialogTitle>
        <Tip label={repo} whenTruncated>
          <p className="truncate text-caption text-cf-text-muted" data-testid={`${testId}-repo`}>
            <RepoRef slug={slug} number={number} />
          </p>
        </Tip>
        <Tip label={prTitle} whenTruncated>
          <DialogDescription className="truncate" data-testid={`${testId}-pr-title`}>
            {prTitle}
          </DialogDescription>
        </Tip>
      </div>
    </div>
  );
}
