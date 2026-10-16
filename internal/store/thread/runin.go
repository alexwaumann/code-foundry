package thread

import (
	"context"
	"fmt"
	"time"
)

// Run in another member ("Run in…", RunIn).
//
// A workspace thread can move its cwd to another member worktree of its workspace.
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
	path, repoID string
}

// RunIn implements Store.
func (m *Manager) RunIn(_ context.Context, id string, t RunInTarget) (Session, error) {
	if t.RepoID == "" && t.WorktreePath == "" {
		return Session{}, fmt.Errorf("%w: a member repo or worktree path is required", ErrInvalidArgument)
	}
	cur, err := m.Get(context.Background(), id)
	if err != nil {
		return Session{}, err
	}
	if cur.WorkspaceID == "" {
		return Session{}, fmt.Errorf("%w: thread %s does not belong to a workspace", ErrFailedPrecondition, id)
	}
	w, mem, err := m.workspaceMember(cur.WorkspaceID, t.RepoID, t.WorktreePath)
	if err != nil {
		return Session{}, err
	}
	if !isDir(mem.WorktreePath) {
		return Session{}, fmt.Errorf("%w: member worktree %s of workspace %s does not exist", ErrFailedPrecondition, mem.WorktreePath, w.Name)
	}

	m.mu.Lock()
	defer m.mu.Unlock()
	rec, err := m.record(id)
	if err != nil {
		return Session{}, err
	}
	switch {
	case rec.s.State == StateClosing:
		return Session{}, fmt.Errorf("%w: thread %s is closing", ErrFailedPrecondition, id)
	case rec.reserved != nil:
		return Session{}, fmt.Errorf("%w: thread %s is starting; try again in a moment", ErrFailedPrecondition, id)
	case rec.run == nil:
		rec.s.WorktreePath, rec.s.RepoID, rec.s.PendingWorktreePath = mem.WorktreePath, mem.RepoID, ""
		m.commitLocked(rec, true)
		m.log.Info("thread moved to another workspace member", "session", id, "path", mem.WorktreePath)
		return rec.s, nil
	}
	req := cdRequest{path: mem.WorktreePath, repoID: mem.RepoID}
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
		m.log.Info("thread move queued until idle", "session", id, "path", req.path)
	}
	return rec.s, nil
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
