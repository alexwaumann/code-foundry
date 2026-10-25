package thread

import (
	"context"
	"fmt"
	"strings"

	"github.com/alexwaumann/code-foundry/internal/store/workspace"
)

// SetWorkspace sets or clears a thread's workspace reference (the GUI's "Save as
// workspace", thread.workspace; docs/notes/workspaces-v2-3-composer.md). Only the
// reference changes: the project set, primary and checkouts stay. Any state;
// persisted; a live process keeps the instructions and add-dirs it started with.
func (m *Manager) SetWorkspace(_ context.Context, id, ref string) (Thread, error) {
	ref = strings.TrimSpace(ref)
	wsID := ""
	if ref != "" {
		if m.opts.Workspaces == nil {
			return Thread{}, fmt.Errorf("%w: workspace references need the workspace store", ErrFailedPrecondition)
		}
		w, err := workspace.ResolveWorkspace(m.opts.Workspaces.Snapshot(), ref)
		if err != nil {
			return Thread{}, workspaceError("workspace", err)
		}
		wsID = w.ID
	}
	m.mu.Lock()
	defer m.mu.Unlock()
	rec, err := m.record(id)
	if err != nil {
		return Thread{}, err
	}
	if err := CheckWorkspaceChange(rec.s, wsID); err != nil {
		return Thread{}, fmt.Errorf("thread %s: %w", id, err)
	}
	if rec.s.WorkspaceID == wsID {
		return rec.s, nil
	}
	rec.s.WorkspaceID = wsID
	m.commitLocked(rec, true)
	m.log.Info("thread workspace reference", "thread", id, "workspace", wsID)
	return rec.s, nil
}

// CheckWorkspaceChange refuses the reference wsID for s when s runs in its workspace's
// folder (no project of its own as the primary): its cwd is that folder. Pure; the fake
// (threadtest) applies it too.
func CheckWorkspaceChange(s Thread, wsID string) error {
	if s.ProjectID == "" && s.WorkspaceID != "" && wsID != s.WorkspaceID {
		return fmt.Errorf("%w: it runs in workspace %s's folder; move it to one of its projects first (thread run-in)", ErrFailedPrecondition, s.WorkspaceID)
	}
	return nil
}
