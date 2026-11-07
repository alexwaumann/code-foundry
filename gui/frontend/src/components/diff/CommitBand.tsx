import { ExternalLink } from "lucide-react";
import type { CompareCommitView } from "@/api/compare";
import { HeaderAction } from "@/components/files/FileHeader";
import { Age } from "@/components/prs/PrBits";
import { openUrl } from "@/stores/gh";
import { commitUrl } from "./commits";

/**
 * Over the diff while the tab shows one commit: its message, sha and age, and its GitHub page.
 * `commit` is null when the list no longer holds it (rebased away, or the list not read yet):
 * the sha alone says which one this is.
 */
export function CommitBand({ sha, commit, slug }: { sha: string; commit: CompareCommitView | null; slug: string | undefined }) {
  const url = commitUrl(slug, sha);
  return (
    <div className="flex shrink-0 flex-col gap-1 overflow-hidden border-b border-cf-divider px-3 py-2" data-testid="diff-commit">
      <div className="flex min-w-0 items-start gap-2">
        <p className="min-w-0 flex-1 text-body-sm font-medium break-words" data-testid="diff-commit-subject">
          {commit?.subject}
        </p>
        <span className="shrink-0 font-mono text-caption-sm" data-testid="diff-commit-sha">
          {commit?.shortSha ?? sha.slice(0, 7)}
        </span>
        {commit && <Age ms={commit.authoredAtMs} className="shrink-0" />}
        {url && (
          <HeaderAction
            icon={ExternalLink}
            label="Open on GitHub"
            testId="diff-commit-github"
            onClick={() => {
              void openUrl(url);
            }}
          />
        )}
      </div>
      {commit?.body && (
        <p className="max-h-24 overflow-y-auto text-caption break-words whitespace-pre-wrap" data-testid="diff-commit-body">
          {commit.body}
        </p>
      )}
    </div>
  );
}
