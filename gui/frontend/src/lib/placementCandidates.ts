/**
 * Which branches a new thread's Create might refuse for a set (thread.placement.check,
 * docs/notes/thread-project-set.md), from what the projects store already knows: a
 * project's main checkout on the branch, or a linked worktree whose folder is the branch's
 * (the daemon's default path ends in the branch with "/" as "-") with another HEAD (made
 * for the branch, then switched away). Only these are asked of the daemon, which has the
 * real rule and the refusal's words; the signature changes when what made a branch a
 * candidate does, so a switch back asks again. Pure.
 */
export interface CandidateWorktree {
  path: string;
  branch: string;
  detached: boolean;
  isMain: boolean;
}

export interface CandidateProject {
  id: string;
  git: boolean;
  worktrees: readonly CandidateWorktree[];
}

/** A branch to check, with the signature of the worktrees that made it one. */
export interface PlacementCandidate {
  branch: string;
  signature: string;
}

/** The last path segment a branch's default worktree folder has ("feat/x" → "feat-x"). */
export function branchFolder(branch: string): string {
  return branch.replaceAll("/", "-");
}

function lastSegment(path: string): string {
  const trimmed = path.replace(/\/+$/, "");
  return trimmed.slice(trimmed.lastIndexOf("/") + 1);
}

export function placementCandidates(projects: readonly CandidateProject[], branches: readonly string[]): PlacementCandidate[] {
  const out: PlacementCandidate[] = [];
  for (const branch of branches) {
    if (!branch) continue;
    const marks: string[] = [];
    for (const p of projects) {
      if (!p.git) continue;
      for (const w of p.worktrees) {
        const head = w.detached ? "(detached)" : w.branch;
        if (w.isMain ? !w.detached && w.branch === branch : lastSegment(w.path) === branchFolder(branch) && (w.detached || w.branch !== branch)) {
          marks.push(`${p.id}:${w.path}:${head}`);
        }
      }
    }
    if (marks.length > 0) out.push({ branch, signature: marks.join("|") });
  }
  return out;
}
