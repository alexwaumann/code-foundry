import { ExternalLink } from "lucide-react";
import { getCompareCommit, type CompareCommitView } from "@/api/compare";
import { HeaderAction } from "@/components/files/FileHeader";
import { useTabRead } from "@/components/files/useTabRead";
import { Age } from "@/components/prs/PrBits";
import { Tip } from "@/components/ui/tooltip";
import { openUrl } from "@/stores/gh";
import { commitSubject, commitUrl } from "./commits";

/**
 * Over the diff while the tab shows one commit: its message, sha and age, and its GitHub page.
 * `commit` is null when the list no longer holds it (rebased away, or the list not read yet):
 * the sha alone says which one this is. The message under the subject is read here, for this one
 * commit: the list carries none. A message can be any length and the diff must stay in reach, so
 * the subject is clamped, the body scrolls, and the band never takes more than its share.
 */
export function CommitBand({ projectId, worktree, sha, commit, slug }: { projectId: string; worktree: string; sha: string; commit: CompareCommitView | null; slug: string | undefined }) {
  const url = commitUrl(slug, sha);
  const message = useTabRead([projectId, worktree, sha].join("\u0000"), (signal) => getCompareCommit({ projectId, worktree }, sha, undefined, signal));
  const body = message.data?.body;
  const subject = commit ? commitSubject(commit) : "";
  return (
    <div className="flex max-h-[40%] shrink-0 flex-col gap-1 overflow-y-auto border-b border-cf-divider px-3 py-2" data-testid="diff-commit">
      <div className="flex min-w-0 items-start gap-2">
        <Tip label={subject} whenTruncated maxLines={8}>
          <p className="line-clamp-2 min-w-0 flex-1 text-body-sm font-medium break-words" data-testid="diff-commit-subject">
            {subject}
          </p>
        </Tip>
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
      {commit?.shallow && (
        <p className="text-caption" data-testid="diff-commit-shallow">
          This clone stops here, so its parent is not on this machine and every file reads as added.
        </p>
      )}
      {body && (
        <p className="max-h-24 shrink-0 overflow-y-auto text-caption break-words whitespace-pre-wrap" data-testid="diff-commit-body">
          {body}
        </p>
      )}
    </div>
  );
}
