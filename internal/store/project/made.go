package project

import (
	"context"
	"fmt"
	"time"
)

// Made worktrees: the project_worktrees table records every worktree CreateWorktree
// adds (a new thread's or workspace's worktree, a recreated one, project.worktree.new),
// and only a recorded one is Worktree.Managed, so cleanable. Being under the worktrees
// directory proves nothing: an agent's own `git worktree add` there is not ours
// (docs/notes/cleanup-eligibility.md). A row goes when the worktree is removed through
// RemoveWorktree or a reconcile of its project no longer lists it. Rows outlive
// Unregister, so a project registered again keeps its worktrees.

// madeWorktree is one project_worktrees row.
type madeWorktree struct {
	projectID string
	head      string // HEAD right after the worktree was made; "" when unknown
	at        time.Time
}

// loadMade reads every recorded worktree, by path.
func (g *Git) loadMade(ctx context.Context) (map[string]madeWorktree, error) {
	rows, err := g.db.QueryContext(ctx, `SELECT path, project_id, head, created_at FROM project_worktrees`)
	if err != nil {
		return nil, fmt.Errorf("project: load made worktrees: %w", err)
	}
	defer func() { _ = rows.Close() }()
	out := map[string]madeWorktree{}
	for rows.Next() {
		var (
			path string
			w    madeWorktree
			ms   int64
		)
		if err := rows.Scan(&path, &w.projectID, &w.head, &ms); err != nil {
			return nil, fmt.Errorf("project: load made worktrees: %w", err)
		}
		w.at = time.UnixMilli(ms)
		out[path] = w
	}
	if err := rows.Err(); err != nil {
		return nil, fmt.Errorf("project: load made worktrees: %w", err)
	}
	return out, nil
}

// recordMade records the worktree CreateWorktree just added at path (resolved), with its
// HEAD now. A failure is logged: the worktree then stays unmanaged, which only means
// cleanup never removes it.
func (g *Git) recordMade(ctx context.Context, projectID, path string) {
	head := ""
	if out, err := g.runner.Run(ctx, path, "rev-parse", "--verify", "--quiet", "HEAD"); err == nil {
		head = string(trimNL(out))
	}
	w := madeWorktree{projectID: projectID, head: head, at: g.now()}
	if _, err := g.db.ExecContext(context.WithoutCancel(ctx), `INSERT INTO project_worktrees (path, project_id, head, created_at)
		VALUES (?, ?, ?, ?) ON CONFLICT (path) DO UPDATE SET project_id = excluded.project_id, head = excluded.head,
		created_at = excluded.created_at`, path, projectID, head, w.at.UnixMilli()); err != nil {
		g.log.Warn("recording a made worktree failed; cleanup will not remove it", "project", projectID, "path", path, "err", err)
		return
	}
	g.mu.Lock()
	g.made[path] = w
	g.mu.Unlock()
}

// forgetMade drops the records of paths (removed worktrees) made at or before t, so a
// worktree made again at one of them meanwhile (a thread resuming) keeps its new record.
func (g *Git) forgetMade(ctx context.Context, t time.Time, paths ...string) {
	if len(paths) == 0 {
		return
	}
	g.mu.Lock()
	for _, p := range paths {
		if w, ok := g.made[p]; ok && !w.at.After(t) {
			delete(g.made, p)
		}
	}
	g.mu.Unlock()
	for _, p := range paths {
		if _, err := g.db.ExecContext(context.WithoutCancel(ctx),
			`DELETE FROM project_worktrees WHERE path = ? AND created_at <= ?`, p, t.UnixMilli()); err != nil {
			g.log.Warn("forgetting a made worktree failed", "path", p, "err", err)
		}
	}
}

// staleMadeLocked returns the recorded worktrees of project id that its listing (seen)
// no longer has and that were made before the listing started (one made meanwhile is
// not listed yet). The caller holds g.mu and passes them to forgetMade after unlocking.
func (g *Git) staleMadeLocked(id string, seen map[string]bool, listedAt time.Time) []string {
	var out []string
	for p, w := range g.made {
		if w.projectID == id && !seen[p] && !w.at.After(listedAt) {
			out = append(out, p)
		}
	}
	return out
}

// managedLocked fills w's Managed, CreatedAt and CreatedHead from the records. The
// caller holds g.mu.
func (g *Git) managedLocked(w *Worktree) {
	if m, ok := g.made[w.Path]; ok && !w.IsMain {
		w.Managed, w.CreatedAt, w.CreatedHead = true, m.at, m.head
	}
}
