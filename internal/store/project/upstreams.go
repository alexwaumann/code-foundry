package project

import (
	"bytes"
	"context"
	"errors"
	"strconv"
	"strings"
)

// Upstream check (docs/notes/project-packed-refs-upstream-check.md). A rewrite of the
// common dir's packed-refs or config is shared by every worktree, and may change any
// worktree's upstream: `fetch --prune` deleting a packed remote-tracking ref (its
// upstream is gone, ahead/behind 0), `git branch -u` or `git push -u` (a new upstream).
// It usually changes nothing a status shows: since git 2.54, auto maintenance after a
// fetch, commit, merge or rebase runs `git pack-refs --all --prune --auto` in the
// foreground whenever enough loose refs piled up, which rewrites packed-refs and
// deletes the loose files without changing any ref's value. So instead of a status for
// every worktree, such an event requests jobUpstreams for the project: one
// `git for-each-ref` reads every branch worktree's ref, upstream and upstream
// ahead/behind, and a status is requested only for the worktrees where that differs
// from what their published status says.
//
// The comparison errs one way only: a worktree is left alone only when its published
// status already shows what git reported after the rewrite. Each slot is compared
// under its lock (the one its status job holds for its whole run): a status running
// when the check reaches it may have read the refs before the rewrite, so the check
// waits for it and compares what it published. A worktree the check cannot compare (a
// failed status, an unborn branch, a failed for-each-ref) gets a status. A detached
// worktree has no upstream to change. A worktree whose upstream is origin/<default>
// itself is the base comparison's (jobBase and jobBaseCounts keep its ahead/behind,
// and may not have run yet for a base that moved in the same fetch), so only its
// upstream name and HEAD are compared here.

// upstreamsCheck is the jobUpstreams body.
func (g *Git) upstreamsCheck(ctx context.Context, projectID string) {
	st := g.project(projectID)
	if st == nil || !st.meta.Load().Git {
		return
	}
	type item struct {
		path string
		slot *wtSlot
	}
	var (
		todo  []item
		names []string
		now   []jobKey // statuses to request without comparing
	)
	g.mu.RLock()
	if g.projects[projectID] != st {
		g.mu.RUnlock()
		return
	}
	for p, slot := range st.wts {
		w := slot.cur.Load()
		switch {
		case w.Status.RefreshedAt.IsZero():
			// No status yet: one is coming (reconcile requests it), and it reads the
			// refs as they are now.
		case w.Status.Error != "" || w.Head == "":
			// A failed status or an unborn branch: nothing reliable to compare with.
			now = append(now, jobKey{kind: jobStatus, projectID: projectID, path: p})
		case w.Detached || w.Branch == "":
			// No branch, so no upstream: packed-refs or config cannot change its status.
		default:
			todo = append(todo, item{path: p, slot: slot})
			names = append(names, "refs/heads/"+w.Branch)
		}
	}
	g.mu.RUnlock()
	for _, k := range now {
		g.sched.requestPrio(k, g.eventPrio(k))
	}
	if len(todo) == 0 {
		return
	}
	args := append([]string{"for-each-ref", "--format=" + upstreamFormat}, names...)
	out, err := g.runner.Run(ctx, st.meta.Load().Path, args...)
	var refs map[string]upstreamInfo
	if err == nil {
		refs, err = parseUpstreams(out)
	}
	if err != nil {
		if ctx.Err() != nil {
			return
		}
		// Cannot tell what changed: refresh them all, as before this check existed.
		g.log.Debug("upstream check failed; refreshing every branch worktree", "project", projectID, "err", err)
		for _, it := range todo {
			k := jobKey{kind: jobStatus, projectID: projectID, path: it.path}
			g.sched.requestPrio(k, g.eventPrio(k))
		}
		return
	}
	var baseRef string
	if b := st.base.Load(); b != nil {
		baseRef = b.ref
	}
	compare := func(it item) {
		w := it.slot.cur.Load()
		same := g.slot(projectID, it.path) != it.slot || upstreamMatches(w, refs["refs/heads/"+w.Branch], baseRef)
		it.slot.mu.Unlock()
		if !same {
			g.log.Debug("upstream changed", "project", projectID, "path", it.path)
			k := jobKey{kind: jobStatus, projectID: projectID, path: it.path}
			g.sched.requestPrio(k, g.eventPrio(k))
		}
	}
	var busy []item
	for _, it := range todo {
		if it.slot.mu.TryLock() {
			compare(it)
		} else {
			busy = append(busy, it)
		}
	}
	// A slot whose status job is running (or jobBaseCounts storing, briefly): that run
	// may have read the refs before the rewrite. Wait for it and compare what it
	// published; a stale one differs from the refs read above and gets a status. The
	// lock is only ever held by a job that is running git, never waiting on another
	// job, so this cannot deadlock; it costs this worker one status's time.
	for _, it := range busy {
		if ctx.Err() != nil {
			return
		}
		it.slot.mu.Lock()
		compare(it)
	}
}

// upstreamFormat is one line per branch: ref, sha, upstream as `git status` names it
// (shortened), and `[ahead N, behind M]` without brackets ("" when even or without an
// upstream, "gone" when the upstream ref does not exist).
const upstreamFormat = "%(refname)%00%(objectname)%00%(upstream:short)%00%(upstream:track,nobracket)"

// upstreamInfo is one branch's line of upstreamFormat. ahead and behind are what
// `git status --porcelain=v2 --branch` reports (0 and 0 for a gone upstream, which
// prints no branch.ab line).
type upstreamInfo struct {
	ok            bool // the branch was listed
	sha           string
	upstream      string
	ahead, behind int
}

// upstreamMatches reports whether w's published status already shows u: its branch
// at the published HEAD, with the same upstream and (unless the upstream is the base
// ref, whose counts the base jobs keep) the same ahead/behind.
func upstreamMatches(w *Worktree, u upstreamInfo, baseRef string) bool {
	if !u.ok || u.sha != w.Head || u.upstream != w.Status.Upstream {
		return false
	}
	if u.upstream != "" && u.upstream == baseRef {
		return true
	}
	return u.ahead == w.Status.Ahead && u.behind == w.Status.Behind
}

// parseUpstreams parses upstreamFormat lines, keyed by full ref name.
func parseUpstreams(out []byte) (map[string]upstreamInfo, error) {
	refs := map[string]upstreamInfo{}
	for line := range bytes.Lines(out) {
		line = trimNL(line)
		if len(line) == 0 {
			continue
		}
		parts := bytes.Split(line, []byte{0})
		if len(parts) != 4 {
			return nil, errors.New("parse for-each-ref upstream: " + string(line))
		}
		u := upstreamInfo{ok: true, sha: string(parts[1]), upstream: string(parts[2])}
		track := string(parts[3])
		if track != "" && track != "gone" {
			for f := range strings.SplitSeq(track, ", ") {
				word, n, ok := strings.Cut(f, " ")
				v, err := strconv.Atoi(n)
				if !ok || err != nil {
					return nil, errors.New("parse for-each-ref upstream track: " + track)
				}
				switch word {
				case "ahead":
					u.ahead = v
				case "behind":
					u.behind = v
				default:
					return nil, errors.New("parse for-each-ref upstream track: " + track)
				}
			}
		}
		refs[string(parts[0])] = u
	}
	return refs, nil
}
