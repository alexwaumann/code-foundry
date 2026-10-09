package repo

import (
	"context"
	"errors"
)

// Base resolution: every worktree compares HEAD with origin/<default branch> (status's
// base ahead/behind, the detail's merge base, files, and log). Those results depend
// only on (HEAD sha, base sha), so status and detail jobs memoize them by that pair and
// rerun the walks only when one side moves. HEAD comes from each status run; the base
// sha is resolved once per repo by jobBase, which owns repoState.base.
//
// jobBase runs wherever a status refresh of every worktree used to be requested: after
// each reconcile (which fetch, FETCH_HEAD, packed-refs, and config changes trigger), on
// any change under refs/remotes/origin, and on every backstop poll. It always ends by
// requesting a status refresh of every worktree, so a status job that starts after a
// base change reads the new sha. Its cost is one `git rev-parse` per repo per round.

// repoBase is origin/<default> as last resolved for a repo. A nil or empty sha means
// there is no such ref (no remote, never fetched, or the repo is in error).
type repoBase struct {
	ref string // "origin/<default>"
	sha string
}

// baseCount memoizes one worktree's base ahead/behind: the counts of `git rev-list
// --left-right --count head...sha`. Written only by the worktree's status job.
type baseCount struct {
	head, ref, sha string
	ahead, behind  int
}

// resolveBase is the jobBase body: the only writer of st.base. It then requests a
// status refresh of every worktree in the repo.
func (g *Git) resolveBase(ctx context.Context, repoID string) {
	st := g.repo(repoID)
	if st == nil {
		return
	}
	m := st.meta.Load()
	next := &repoBase{}
	if m.Error == "" && m.DefaultBranch != "" {
		next.ref = "origin/" + m.DefaultBranch
		// ^{commit} peels a tag and fails for a non-commit, which rev-list would too.
		out, err := g.runner.Run(ctx, m.Path, "rev-parse", "--verify", "--quiet",
			"refs/remotes/"+next.ref+"^{commit}")
		switch {
		case err == nil:
			next.sha = string(trimNL(out))
		case ctx.Err() != nil:
			return
		case !isExit(err, 1):
			// Not "missing": keep what we had rather than dropping the base comparison
			// on a transient failure. The next round retries.
			g.log.Debug("resolve base failed", "repo", repoID, "ref", next.ref, "err", err)
			if prev := st.base.Load(); prev != nil {
				next = prev
			}
		}
	}
	if prev := st.base.Load(); prev == nil || *prev != *next {
		g.log.Debug("base resolved", "repo", repoID, "ref", next.ref, "sha", next.sha)
	}
	st.base.Store(next)
	for _, k := range g.statusKeys(repoID) {
		g.sched.request(k)
	}
}

// baseCounts returns HEAD's ahead/behind against the repo's base, reusing the
// worktree's memo when neither HEAD nor the base moved. ok is false when there is no
// base comparison (no base ref, unborn HEAD, or rev-list failed). reused reports a memo
// hit. Called only by the worktree's status job, which owns slot.base.
func (g *Git) baseCounts(ctx context.Context, st *repoState, slot *wtSlot, dir, head string) (c baseCount, ok, reused bool) {
	b := st.base.Load()
	if b == nil || b.sha == "" || head == "" {
		slot.base.Store(nil)
		return baseCount{}, false, false
	}
	if m := slot.base.Load(); m != nil && m.head == head && m.ref == b.ref && m.sha == b.sha {
		return *m, true, true
	}
	out, err := g.runner.Run(ctx, dir, "rev-list", "--left-right", "--count", head+"..."+b.sha)
	if err != nil {
		slot.base.Store(nil)
		return baseCount{}, false, false
	}
	a, behind, err := parseLeftRightCount(out)
	if err != nil {
		slot.base.Store(nil)
		return baseCount{}, false, false
	}
	c = baseCount{head: head, ref: b.ref, sha: b.sha, ahead: a, behind: behind}
	slot.base.Store(&c)
	return c, true, false
}

// isExit reports whether err is a *GitError with the given exit code.
func isExit(err error, code int) bool {
	var ge *GitError
	return errors.As(err, &ge) && ge.ExitCode == code
}

// shortSHA abbreviates a sha for logs.
func shortSHA(s string) string {
	if len(s) > 12 {
		return s[:12]
	}
	return s
}
