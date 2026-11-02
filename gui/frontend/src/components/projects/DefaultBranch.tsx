import { ChecksBadge } from "@/components/prs/PrBits";
import { defaultBranchCell } from "@/lib/projects";
import { openUrl, repoActivityResource } from "@/stores/gh";
import { useProjectsStore } from "@/stores/projects";
import { useResource } from "@/stores/resource";

/** The checks, a button opening the first failed one when there is one. */
function Checks({ url, children, testId }: { url: string; children: React.ReactNode; testId: string }) {
  if (!url) {
    return (
      <span className="flex min-w-0 shrink-0" data-testid={testId}>
        {children}
      </span>
    );
  }
  return (
    <button
      type="button"
      tabIndex={-1}
      className="flex min-w-0 shrink-0 hover:underline"
      data-testid={testId}
      onClick={(e) => {
        e.stopPropagation();
        void openUrl(url);
      }}
    >
      {children}
    </button>
  );
}

/**
 * The project's default branch and its checks (the daemon polls every tracked GitHub
 * repository's), watched while it shows. A click on failing checks opens the first failed
 * one.
 *
 * - "cell" (the index's Default branch column): the branch in mono, then the checks; "—"
 *   off GitHub and until the status arrives.
 * - "title" (a project page's meta line): one badge in the checks' tone, "⊗ main 2/16
 *   failing"; until the status arrives, and off GitHub, the branch name alone (the store's);
 *   nothing without one.
 */
export function DefaultBranch({ projectId, variant = "cell" }: { projectId: string; variant?: "cell" | "title" }) {
  const slug = useProjectsStore((s) => s.byId[projectId]?.githubSlug.toLowerCase() ?? "");
  const known = useProjectsStore((s) => s.byId[projectId]?.defaultBranch ?? "");
  const entry = useResource(repoActivityResource, slug === "" ? null : slug);
  const cell = defaultBranchCell(slug, entry?.data?.defaultBranch);
  if (variant === "title") {
    if (!cell) {
      if (!known) return null;
      return (
        <span className="min-w-0 shrink truncate" data-testid="title-default-branch">
          {known}
        </span>
      );
    }
    return (
      <Checks url={cell.failingUrl} testId="title-default-branch">
        <ChecksBadge checks={cell.rollup} branch={cell.branch} className="text-caption [&_svg]:size-3" />
      </Checks>
    );
  }
  if (!cell) {
    return (
      <span className="text-body-sm text-cf-text-muted" data-testid="index-default-branch">
        —
      </span>
    );
  }
  return (
    <span className="flex min-w-0 items-center gap-2" data-testid="index-default-branch">
      <span className="min-w-0 shrink truncate font-mono text-caption text-cf-text-muted" data-testid="index-default-branch-name">
        {cell.branch}
      </span>
      <Checks url={cell.failingUrl} testId="index-checks">
        <ChecksBadge checks={cell.rollup} />
      </Checks>
    </span>
  );
}
