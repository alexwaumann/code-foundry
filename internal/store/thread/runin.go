package thread

import (
	"cmp"
	"context"
	"fmt"
	"path/filepath"
	"slices"
	"strings"
	"time"

	"github.com/alexwaumann/code-foundry/internal/store/workspace"
)

// Run in another member ("Run in…", RunIn).
//
// A thread can move its cwd to another of its checkouts (checkouts.go): that member
// becomes the primary.
// The runner holds the request until Claude is idle at its prompt, then sends set_cwd
// over the control protocol (streamCd in stream.go), which keeps the conversation and
// the --add-dir directories and loads the new directory's CLAUDE.md, settings, hooks
// and MCP servers; the row's cwd changes once Claude accepts. A request made while the
// thread has no process changes the row at once (claude --resume finds the
// conversation from any cwd); one still queued when the process ends is applied the
// same way.

// cdSettle is how long Claude must have been at its prompt before the move, so a
// momentary "at prompt" (between a send and the turn it starts) does not count.
const cdSettle = time.Second

// cdRequest is a queued move. An empty path cancels the queued move.
type cdRequest struct {
	path, projectID string
}

// RunIn implements Store.
func (m *Manager) RunIn(_ context.Context, id string, t RunInTarget) (Thread, error) {
	if t.ProjectID == "" && t.WorktreePath == "" {
		return Thread{}, fmt.Errorf("%w: a member project or worktree path is required", ErrInvalidArgument)
	}
	cur, err := m.Get(context.Background(), id)
	if err != nil {
		return Thread{}, err
	}
	if len(cur.Projects()) == 0 {
		return Thread{}, fmt.Errorf("%w: thread %s has no project to run in", ErrFailedPrecondition, id)
	}
	c, err := m.runInTarget(cur, t)
	if err != nil {
		return Thread{}, err
	}
	if c.Missing {
		return Thread{}, fmt.Errorf("%w: checkout %s of project %s does not exist", ErrFailedPrecondition, c.Path, cmp.Or(c.ProjectName, c.ProjectID))
	}
	mem := struct{ ProjectID, WorktreePath string }{c.ProjectID, c.Path}
	if mem.ProjectID == workspace.PrimaryWorkspace {
		mem.ProjectID = "" // the workspace's folder: no project is the primary
	}

	m.mu.Lock()
	defer m.mu.Unlock()
	rec, err := m.record(id)
	if err != nil {
		return Thread{}, err
	}
	switch {
	case rec.s.State == StateClosing:
		return Thread{}, fmt.Errorf("%w: thread %s is closing", ErrFailedPrecondition, id)
	case rec.reserved != nil:
		return Thread{}, fmt.Errorf("%w: thread %s is starting; try again in a moment", ErrFailedPrecondition, id)
	case rec.run == nil:
		rec.s = rec.s.movedTo(mem.ProjectID, mem.WorktreePath)
		rec.s.PendingWorktreePath = ""
		m.commitLocked(rec, true)
		m.log.Info("thread moved to another checkout", "thread", id, "path", mem.WorktreePath)
		return rec.s, nil
	}
	req := cdRequest{path: mem.WorktreePath, projectID: mem.ProjectID}
	if samePath(rec.s.WorktreePath, mem.WorktreePath) {
		req = cdRequest{} // already there: cancel whatever is queued
	}
	if rec.s.PendingWorktreePath == req.path {
		return rec.s, nil
	}
	rec.s.PendingWorktreePath = req.path
	// Latest wins. Only RunIn sends, under m.mu, so draining then sending never blocks.
	select {
	case <-rec.run.cdReq:
	default:
	}
	rec.run.cdReq <- req
	m.commitLocked(rec, false)
	if req.path != "" {
		m.log.Info("thread move queued until idle", "thread", id, "path", req.path)
	}
	return rec.s, nil
}

// runInTarget is the checkout of cur that t names: by path (cleaned or symlink-resolved,
// the checkout itself), else by project id or name; both given must agree. A path or
// project that is not one of cur's checkouts is refused.
func (m *Manager) runInTarget(cur Thread, t RunInTarget) (Checkout, error) {
	cos := m.checkouts(cur)
	if w, ok := m.workspaceOf(cur); ok && isDir(w.Dir()) {
		// The workspace's folder is a place too ("workspace" as the project).
		cos = append(cos, Checkout{ProjectID: workspace.PrimaryWorkspace, ProjectName: w.Name, Path: w.Dir(), Primary: cur.ProjectID == ""})
	}
	if len(cos) < 2 {
		return Checkout{}, fmt.Errorf("%w: thread %s has no other checkout to run in", ErrFailedPrecondition, cur.ID)
	}
	list := func() string {
		parts := make([]string, 0, len(cos))
		for _, c := range cos {
			parts = append(parts, cmp.Or(c.ProjectName, c.ProjectID)+" "+cmp.Or(c.Path, "?"))
		}
		return strings.Join(parts, ", ")
	}
	if t.WorktreePath != "" && !filepath.IsAbs(t.WorktreePath) {
		return Checkout{}, fmt.Errorf("%w: worktree path %q must be absolute", ErrInvalidArgument, t.WorktreePath)
	}
	byProject := func(ref string) int {
		return slices.IndexFunc(cos, func(c Checkout) bool { return c.ProjectID == ref || (c.ProjectName != "" && c.ProjectName == ref) })
	}
	switch {
	case t.WorktreePath != "":
		i := slices.IndexFunc(cos, func(c Checkout) bool { return c.Path != "" && samePath(c.Path, t.WorktreePath) })
		if i < 0 {
			return Checkout{}, fmt.Errorf("%w: %s is not one of thread %s's checkouts (%s)", ErrFailedPrecondition, t.WorktreePath, cur.ID, list())
		}
		if t.ProjectID != "" && byProject(t.ProjectID) != i {
			return Checkout{}, fmt.Errorf("%w: checkout %s belongs to project %s, not %s", ErrInvalidArgument, t.WorktreePath, cos[i].ProjectID, t.ProjectID)
		}
		return cos[i], nil
	default:
		i := byProject(t.ProjectID)
		if i < 0 {
			return Checkout{}, fmt.Errorf("%w: project %s is not one of thread %s's projects (%s)", ErrFailedPrecondition, t.ProjectID, cur.ID, list())
		}
		return cos[i], nil
	}
}

// onCdRequest takes a request from RunIn.
func (r *runner) onCdRequest(req cdRequest) {
	if req.path == "" {
		r.pendingCd = nil
		return
	}
	r.pendingCd = &req
	r.tryCd()
}

// tryCd moves the thread for the queued request once Claude is connected, not
// closing or restarting, and has been at its prompt for cdSettle. It runs after every
// stream event and tick, so it also keeps atPromptSince current.
func (r *runner) tryCd() {
	// Take a newer request first (select picks among ready cases at random, so a
	// cancel may still sit in the channel when a tick gets here).
	select {
	case req := <-r.cdReq:
		if req.path == "" {
			r.pendingCd = nil
		} else {
			r.pendingCd = &req
		}
	default:
	}
	if !r.st.sd.AtPrompt() {
		r.atPromptSince = time.Time{}
	} else if r.atPromptSince.IsZero() {
		r.atPromptSince = time.Now()
	}
	if r.pendingCd == nil || r.closing || r.state != StateConnected || r.restarting() ||
		r.atPromptSince.IsZero() || time.Since(r.atPromptSince) < cdSettle {
		return
	}
	req := *r.pendingCd
	r.pendingCd = nil
	if !isDir(req.path) {
		r.log().warn("queued move dropped: worktree is gone", "path", req.path)
		r.m.update(r.id, false, func(rec *record) {
			if rec.s.PendingWorktreePath == req.path {
				rec.s.PendingWorktreePath = ""
			}
			rec.s.LastError = "run in " + req.path + ": the worktree no longer exists"
		})
		return
	}
	r.streamCd(req)
}

// unsentCd is the move a finishing runner still owes: the queued one, including one
// RunIn sent that the loop has not taken yet.
func (r *runner) unsentCd() *cdRequest {
	select {
	case req := <-r.cdReq:
		if req.path == "" {
			return nil
		}
		return &req
	default:
	}
	return r.pendingCd
}
