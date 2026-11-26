package project

import (
	"bytes"
	"context"
	"errors"
	"strings"
)

// Lazy base counts (docs/notes/project-lazy-base-counts.md). A move of
// origin/<default> changes only the base comparison of a worktree (ahead/behind
// against the base, and whether its work landed; for a worktree whose upstream is
// origin/<default> itself, its upstream ahead/behind, the same comparison), never its
// dirty state. So when the
// base moves, resolveBase refreshes the status of active worktrees (a live thread or a
// watched detail) as before, and requests jobBaseCounts for the project, which brings
// every other worktree's base comparison up to date without a `git status`:
//
//   - one `git for-each-ref --format=... %(ahead-behind:<base>) refs/heads/<branch>...`
//     (git 2.41+) for the worktrees on a branch whose ref is at their published HEAD;
//   - `git rev-list --left-right --count` per worktree otherwise (detached HEAD, a ref
//     that moved since the status, or an older git);
//   - the merged-by-content check (merged.go) for a diverged worktree that is not main,
//     as the status job does, before anything is published: cleanup eligibility and
//     auto-tidy read Landed().
//
// Ownership: a worktree's slot (cur and base) is written by its status job, and by
// this job only while it holds slot.mu, which the status job holds for its whole run.
// This job only tries the lock: a slot whose status job is running gets a status
// request instead (the run may have read the old base), so it never waits on git. What
// it stores is exactly what the status job would compute from the same (HEAD, base),
// including the memo, so the next status run reuses it and agrees.

// baseCountsBatch is the jobBaseCounts body: it compares every worktree of the project
// whose stored comparison is not against the current (HEAD, base) with the base, and
// stores and publishes the result. A worktree whose last status failed gets a status
// retried instead (low priority); one with no status yet (resolveBase requested it) or
// an unborn HEAD (no comparison) is left alone.
func (g *Git) baseCountsBatch(ctx context.Context, projectID string) {
	st := g.project(projectID)
	if st == nil || !st.meta.Load().Git {
		return
	}
	lz := st.lazy.Load()
	if lz == nil || lz.base.sha == "" {
		return
	}
	b := &lz.base
	if cur := st.base.Load(); cur == nil || *cur != *b {
		return // resolved again since: that resolution decides (and requests us again)
	}
	type item struct {
		path string
		slot *wtSlot
		w    *Worktree
	}
	var (
		todo  []item
		retry []jobKey
	)
	g.mu.RLock()
	if g.projects[projectID] != st {
		g.mu.RUnlock()
		return
	}
	for p, slot := range st.wts {
		if lz.statused[p] {
			continue // its status job compares it (an active or new worktree)
		}
		w := slot.cur.Load()
		if w.Status.Error != "" {
			// Its last status failed, so it has no comparison to update: retry the
			// status, as the status-every-worktree base move did.
			retry = append(retry, jobKey{kind: jobStatus, projectID: projectID, path: p})
			continue
		}
		if w.Status.RefreshedAt.IsZero() || w.Head == "" {
			continue // no status yet (one is coming), or unborn: nothing to compare
		}
		if m := slot.base.Load(); m != nil && m.head == w.Head && m.ref == b.ref && m.sha == b.sha {
			continue // already compared with this base (its status job ran since)
		}
		todo = append(todo, item{path: p, slot: slot, w: w})
	}
	g.mu.RUnlock()
	for _, k := range retry {
		g.sched.requestPrio(k, prioLow)
	}
	if len(todo) == 0 {
		return
	}
	dir := st.meta.Load().Path

	// Counts of every branch worktree in one process, keyed by full ref name.
	var refs map[string]refCount
	if !g.aheadBehindUnsupported.Load() {
		var names []string
		for _, it := range todo {
			if !it.w.Detached && it.w.Branch != "" {
				names = append(names, "refs/heads/"+it.w.Branch)
			}
		}
		if len(names) > 0 {
			var err error
			refs, err = g.aheadBehind(ctx, dir, b.sha, names)
			switch {
			case ctx.Err() != nil:
				return
			case err != nil:
				var ge *GitError
				if errors.As(err, &ge) && strings.Contains(ge.Stderr, "ahead-behind") {
					g.aheadBehindUnsupported.Store(true)
					g.log.Info("git has no %(ahead-behind); base counts use rev-list per worktree", "project", projectID)
				} else {
					g.log.Debug("for-each-ref ahead-behind failed", "project", projectID, "err", err)
				}
			}
		}
	}

	for _, it := range todo {
		if ctx.Err() != nil {
			return
		}
		c := baseCount{head: it.w.Head, ref: b.ref, sha: b.sha}
		if r, ok := refs["refs/heads/"+it.w.Branch]; ok && !it.w.Detached && r.sha == it.w.Head {
			c.ahead, c.behind = r.ahead, r.behind
		} else {
			out, err := g.runner.Run(ctx, dir, "rev-list", "--left-right", "--count", it.w.Head+"..."+b.sha)
			if err == nil {
				c.ahead, c.behind, err = parseLeftRightCount(out)
			}
			if err != nil {
				if ctx.Err() != nil {
					return
				}
				// The status job decides what a failed comparison publishes.
				g.sched.requestPrio(jobKey{kind: jobStatus, projectID: projectID, path: it.path}, prioLow)
				continue
			}
		}
		// As baseCounts: only a diverged worktree can have landed by content, and main
		// never needs to (never a cleanup or leftover candidate).
		if c.ahead > 0 && c.behind > 0 {
			if !it.w.IsMain {
				c.merged = g.mergedByContent(ctx, it.path, c.head, c.sha)
				c.mergedChecked = true
			}
		} else {
			c.mergedChecked = true
		}
		if ctx.Err() != nil {
			return
		}
		g.applyBaseCount(st, projectID, it.path, it.slot, b, c)
	}
}

// applyBaseCount stores c as the slot's base comparison and publishes the worktree if
// its base fields changed, unless the slot moved on: removed, its status job running
// (then that worktree gets a status instead), its HEAD moved, or the base moved again
// (a newer jobBaseCounts follows).
func (g *Git) applyBaseCount(st *projectState, projectID, path string, slot *wtSlot, b *projectBase, c baseCount) {
	if !slot.mu.TryLock() {
		g.sched.requestPrio(jobKey{kind: jobStatus, projectID: projectID, path: path}, prioLow)
		return
	}
	cur := slot.cur.Load()
	if g.slot(projectID, path) != slot || cur.Head != c.head || cur.Status.Error != "" {
		slot.mu.Unlock()
		return
	}
	if nb := st.base.Load(); nb == nil || *nb != *b {
		slot.mu.Unlock()
		return
	}
	slot.base.Store(&c)
	next := *cur
	next.Status.BaseRef, next.Status.BaseAhead, next.Status.BaseBehind = c.ref, c.ahead, c.behind
	next.Status.BaseMerged = c.merged
	if cur.Status.Upstream == c.ref {
		// Tracking the base ref itself (the main checkout, usually): git status's
		// upstream ahead/behind is this same comparison, and moved with it.
		next.Status.Ahead, next.Status.Behind = c.ahead, c.behind
	}
	changed := next.Status != cur.Status
	if changed {
		slot.cur.Store(&next)
	}
	slot.mu.Unlock()
	if !changed {
		return
	}
	g.log.Debug("worktree base counts changed", "project", projectID, "path", path, "head", shortSHA(c.head),
		"base", shortSHA(c.sha), "ahead", c.ahead, "behind", c.behind, "merged", c.merged)
	g.commit(func(s *Snapshot) []Event {
		if w, ok := s.Worktree(projectID, path); ok {
			return []Event{WorktreeUpdated{Worktree: w}}
		}
		return nil
	})
	g.snapCache.markDirty(projectID)
}

// lazyBase is a base move resolveBase left to jobBaseCounts: the base, and the
// worktrees it requested a status for instead (active, or without a status yet). It
// is decided once per move, so a worktree that turns active between the two jobs is
// still covered by one of them.
type lazyBase struct {
	base     projectBase
	statused map[string]bool
}

// refCount is one branch's line of aheadBehind.
type refCount struct {
	sha           string
	ahead, behind int
}

// aheadBehind runs one `git for-each-ref` for the given full ref names, returning each
// ref's sha and its ahead/behind against base (as `rev-list --left-right --count
// ref...base` counts them). Needs git 2.41.
func (g *Git) aheadBehind(ctx context.Context, dir, base string, refs []string) (map[string]refCount, error) {
	args := append([]string{"for-each-ref", "--format=%(refname)%00%(objectname)%00%(ahead-behind:" + base + ")"}, refs...)
	out, err := g.runner.Run(ctx, dir, args...)
	if err != nil {
		return nil, err
	}
	return parseAheadBehind(out)
}

// parseAheadBehind parses aheadBehind's output: one "<ref>\0<sha>\0<ahead> <behind>"
// line per ref.
func parseAheadBehind(out []byte) (map[string]refCount, error) {
	refs := map[string]refCount{}
	for line := range bytes.Lines(out) {
		line = trimNL(line)
		if len(line) == 0 {
			continue
		}
		parts := bytes.Split(line, []byte{0})
		if len(parts) != 3 {
			return nil, errors.New("parse for-each-ref ahead-behind: " + string(line))
		}
		ahead, behind, err := parseLeftRightCount(parts[2])
		if err != nil {
			return nil, err
		}
		refs[string(parts[0])] = refCount{sha: string(parts[1]), ahead: ahead, behind: behind}
	}
	return refs, nil
}
