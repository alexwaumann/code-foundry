package project

import (
	"context"
	"errors"
)

// Base resolution: every worktree compares HEAD with origin/<default branch> (status's
// base ahead/behind, the detail's merge base, files, and log). Those results depend
// only on (HEAD sha, base sha), so status and detail jobs memoize them by that pair and
// rerun the walks only when one side moves. HEAD comes from each status run; the base
// sha is resolved once per project by jobBase, which owns projectState.base.
//
// jobBase runs after reconcile, on FETCH_HEAD and remote-ref changes, and after
// store-initiated fetches. When the resolved (ref, sha) moves, it refreshes the status
// of the active worktrees (a live thread or a watched detail) and requests
// jobBaseCounts, which brings every other worktree's base comparison up to date
// without a status (basecounts.go); on the first resolution and when the base goes
// away, it refreshes every status. When unchanged, it refreshes only uninitialized
// worktrees. Its own cost is one `git rev-parse` per project per round.

// projectBase is origin/<default> as last resolved for a project. A nil or empty sha means
// there is no such ref (no remote, never fetched, or the project is in error).
type projectBase struct {
	ref string // "origin/<default>"
	sha string
}

// baseCount memoizes one worktree's base ahead/behind: the counts of `git rev-list
// --left-right --count head...sha`, and whether head's changes are in sha by content
// (mergedByContent). Written by the worktree's status job, and by jobBaseCounts while
// it holds the slot's mu.
type baseCount struct {
	head, ref, sha string
	ahead, behind  int
	merged         bool
	// mergedChecked reports whether mergedByContent has been evaluated (or was
	// unnecessary because the worktree is not both ahead and behind). Main worktrees
	// skip mergedByContent (they are never cleanup/leftover candidates); non-main
	// worktrees evaluate and memoize it per (head, base).
	mergedChecked bool
}

// resolveBase is the jobBase body: the only writer of st.base. See the file comment
// for what it refreshes.
func (g *Git) resolveBase(ctx context.Context, projectID string) {
	g.refsCache.invalidate(projectID)
	st := g.project(projectID)
	if st == nil {
		return
	}
	m := st.meta.Load()
	next := &projectBase{}
	if !m.Git {
		st.base.Store(next) // no base, and no status to refresh (nogit.go)
		return
	}
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
			g.log.Debug("resolve base failed", "project", projectID, "ref", next.ref, "err", err)
			if prev := st.base.Load(); prev != nil {
				next = prev
			}
		}
	}
	prev := st.base.Load()
	changed := prev == nil || *prev != *next
	if changed {
		g.log.Debug("base resolved", "project", projectID, "ref", next.ref, "sha", next.sha)
	}
	st.base.Store(next)
	keys := g.uninitializedStatusKeys(projectID)
	switch {
	case !changed:
	case prev == nil || next.sha == "":
		// The first resolution after start (hydrated slots, every status due anyway),
		// or no base any more: every status, which also clears the base fields.
		keys = g.statusKeys(projectID)
	default:
		// Only the base comparison moved: active worktrees get their status as
		// before; jobBaseCounts covers the rest without one.
		lz := &lazyBase{base: *next, statused: map[string]bool{}}
		for _, k := range keys {
			lz.statused[k.path] = true
		}
		for _, k := range g.statusKeys(projectID) {
			if g.worktreeActive(projectID, k.path) {
				keys = append(keys, k)
				lz.statused[k.path] = true
			}
		}
		st.lazy.Store(lz)
		g.sched.requestPrio(jobKey{kind: jobBaseCounts, projectID: projectID}, prioLow)
	}
	for _, k := range keys {
		g.sched.requestPrio(k, g.eventPrio(k))
	}
}

// baseCounts returns HEAD's ahead/behind against the project's base, reusing the
// worktree's memo when neither HEAD nor the base moved. ok is false when there is no
// base comparison (no base ref, unborn HEAD, or rev-list failed). reused reports a memo
// hit. checkMerged gates mergedByContent (skipped for the main worktree, which is never
// a leftover or cleanup candidate). Called only by the worktree's status job, while it
// holds slot.mu.
func (g *Git) baseCounts(ctx context.Context, st *projectState, slot *wtSlot, dir, head string, checkMerged bool) (c baseCount, ok, reused bool) {
	b := st.base.Load()
	if b == nil || b.sha == "" || head == "" {
		slot.base.Store(nil)
		return baseCount{}, false, false
	}
	if m := slot.base.Load(); m != nil && m.head == head && m.ref == b.ref && m.sha == b.sha {
		if !checkMerged || m.mergedChecked || m.ahead == 0 || m.behind == 0 {
			return *m, true, true
		}
		c = *m
		c.merged = g.mergedByContent(ctx, dir, head, b.sha)
		c.mergedChecked = true
		slot.base.Store(&c)
		return c, true, false
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
	if a > 0 && behind > 0 {
		if checkMerged {
			// Only then can a rebased or squash-merged copy of head have landed in the base.
			c.merged = g.mergedByContent(ctx, dir, head, b.sha)
			c.mergedChecked = true
		}
	} else {
		c.mergedChecked = true
	}
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
