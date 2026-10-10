package session

import (
	"context"
	"fmt"
	"time"
)

// Run in another member ("Run in…", RunIn).
//
// A workspace thread can move its cwd to another member worktree of its workspace.
// Claude's `/cd <path>` does that inside a running conversation (it keeps the
// conversation and the --add-dir directories, and loads the new directory's
// CLAUDE.md, settings, hooks and MCP servers). The runner holds the request until
// Claude is idle at its prompt, types the command, waits cdEnterGap, presses Enter, and
// only then records the new cwd on the row. A request made while the thread has no
// process changes the row at once (claude --resume finds the conversation from any
// cwd); one still queued when the process ends is applied the same way.

// cdEnterGap separates typing `/cd <path>` from pressing Enter: one chunk ending in
// "\r" can be taken as a paste, which inserts a newline instead of submitting.
const cdEnterGap = 400 * time.Millisecond

// cdSettle is how long Claude must have been at its prompt before `/cd` is typed, so a
// momentary "at prompt" (the idle title before the first prompt is submitted, the
// instant after the user presses Enter) does not count. Input typed during a turn is
// queued by Claude and runs after it (observed), but the row would move too early.
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

// atPrompt reports whether Claude waits at its prompt with nothing open, so typed
// input becomes the next prompt. A detector may implement AtPrompt() (internal/
// claudestatus does: idle, or a finished turn nobody has looked at yet); otherwise
// only StatusIdle counts.
func atPrompt(d StatusDetector) bool {
	if p, ok := d.(interface{ AtPrompt() bool }); ok {
		return p.AtPrompt()
	}
	st, _ := d.Status()
	return st == StatusIdle
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

// tryCd types the queued `/cd` once Claude is connected, not closing, past its first
// prompt (a positional prompt is submitted only after the UI is up), and has been at
// its prompt for cdSettle. Enter follows after cdEnterGap (sendCd). It runs after every
// output batch and tick, so it also keeps atPromptSince current.
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
	if st, _ := r.det.Status(); st == StatusBusy {
		r.awaitFirstPrompt = false
	}
	if !atPrompt(r.det) {
		r.atPromptSince = time.Time{}
	} else if r.atPromptSince.IsZero() {
		r.atPromptSince = time.Now()
	}
	if r.pendingCd == nil || r.cdTimer != nil || r.closing || r.state != StateConnected || r.awaitFirstPrompt ||
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
	r.log().info("typing /cd", "path", req.path)
	r.write("/cd " + req.path)
	r.cdSending = req
	r.cdTimer = time.NewTimer(cdEnterGap)
}

// sendCd presses Enter on the typed `/cd` and records the new cwd.
func (r *runner) sendCd() {
	r.cdTimer = nil
	req := r.cdSending
	r.cdSending = cdRequest{}
	r.write(keyEnter)
	r.cwd = req.path
	// Claude moves the transcript into the new cwd's project dir (a rename: the open
	// file keeps being read). Watch the new dir, and reopen there if the file closes.
	r.tail.cwd = req.path
	r.m.update(r.id, true, func(rec *record) {
		rec.s.WorktreePath, rec.s.RepoID = req.path, req.repoID
		if rec.s.PendingWorktreePath == req.path {
			rec.s.PendingWorktreePath = ""
		}
	})
	r.log().info("thread moved to another workspace member", "path", req.path)
}

// unsentCd is the move a finishing runner still owes: the queued one (including one
// RunIn sent that the loop has not taken yet), else one typed but not yet entered.
func (r *runner) unsentCd() *cdRequest {
	select {
	case req := <-r.cdReq:
		if req.path == "" {
			return nil
		}
		return &req
	default:
	}
	if r.pendingCd != nil {
		return r.pendingCd
	}
	if r.cdTimer != nil {
		req := r.cdSending
		return &req
	}
	return nil
}
