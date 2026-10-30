package thread

import (
	"cmp"
	"context"
	"errors"
	"fmt"
	"maps"
	"slices"
	"strings"

	"github.com/alexwaumann/code-foundry/internal/store/project"
)

// A thread's project set after Create (docs/notes/thread-project-set.md): AddProject
// and RemoveProject add a member or drop one that is not the cwd.
//
// An added member gets a checkout by the creation rule: in worktree mode a git
// project's worktree for the thread's branch (memberWorktree, else made, with Create's
// refusals: mainCheckoutBusy, defaultPathTaken), a plain folder its folder; in checkout
// mode the project's own checkout. A removed member's checkout stays on disk; only the
// record goes. A thread that referenced a workspace leaves it (WorkspaceID cleared, the
// workspace untouched): its set is its own now. Both are told in the timeline.
//
// Claude has no control request that changes the --add-dir list of a running
// process, so a live thread restarts (resuming the conversation, effort.go's restart)
// once it is quiet at its prompt, as an effort change does; a thread without a process
// takes the new list at its next start.

// AddProject implements Store.
func (m *Manager) AddProject(ctx context.Context, id, ref string) (Thread, error) {
	if m.opts.Projects == nil {
		return Thread{}, fmt.Errorf("%w: adding a project needs the project store", ErrFailedPrecondition)
	}
	cur, err := m.Get(ctx, id)
	if err != nil {
		return Thread{}, err
	}
	if err := CheckMembersChange(cur); err != nil {
		return Thread{}, err
	}
	r, err := m.projectByRef(m.opts.Projects.Snapshot(), strings.TrimSpace(ref))
	if err != nil {
		return Thread{}, err
	}
	if slices.Contains(cur.Projects(), r.ID) {
		return Thread{}, fmt.Errorf("%w: project %s is already one of thread %s's projects", ErrFailedPrecondition, r.Name, id)
	}
	path, made, err := m.placeMember(ctx, cur, r)
	if err != nil {
		return Thread{}, err
	}
	s, left, err := m.changeMembers(id, func(s Thread) (Thread, error) {
		if slices.Contains(s.Projects(), r.ID) {
			return s, fmt.Errorf("%w: project %s is already one of thread %s's projects", ErrFailedPrecondition, r.Name, id)
		}
		return WithMember(s, r.ID, path), nil
	})
	if err != nil {
		if made != nil {
			m.rollback(ctx, []madeWorktree{*made})
		}
		return Thread{}, err
	}
	if !m.opts.DisablePreTrust {
		// A spawn pre-trusts every checkout (preTrustCheckouts); the restart that gives
		// Claude this one does not go through it.
		if _, err := trustWorktree(m.opts.Paths.Config, path); err != nil {
			m.log.Warn("pre-trust added member", "thread", id, "path", path, "err", err)
		}
	}
	m.log.Info("project added to thread", "thread", id, "project", r.ID, "path", path, "made", made != nil, "left_workspace", left)
	if made != nil && m.opts.WorktreeCreated != nil {
		m.opts.WorktreeCreated(id, r.ID, made.path)
	}
	m.noteMembers(ctx, id, addedNote(r.Name, path, made != nil, m.workspaceName(left)))
	return s, nil
}

// RemoveProject implements Store.
func (m *Manager) RemoveProject(ctx context.Context, id, ref string) (Thread, error) {
	cur, err := m.Get(ctx, id)
	if err != nil {
		return Thread{}, err
	}
	if err := CheckMembersChange(cur); err != nil {
		return Thread{}, err
	}
	pid, name := m.memberByRef(cur, strings.TrimSpace(ref))
	if pid == "" {
		return Thread{}, fmt.Errorf("%w: %q is not one of thread %s's projects (%s)", ErrFailedPrecondition, ref, id, strings.Join(cur.Projects(), ", "))
	}
	var path string
	s, left, err := m.changeMembers(id, func(s Thread) (Thread, error) {
		if !slices.Contains(s.Projects(), pid) {
			return s, fmt.Errorf("%w: %s is not one of thread %s's projects", ErrFailedPrecondition, name, id)
		}
		path, _ = s.CheckoutPath(pid)
		return WithoutMember(s, pid, name)
	})
	if err != nil {
		return Thread{}, err
	}
	m.log.Info("project removed from thread", "thread", id, "project", pid, "checkout", path, "left_workspace", left)
	m.noteMembers(ctx, id, removedNote(name, path, m.workspaceName(left)))
	return s, nil
}

// CheckMembersChange refuses a set change for a thread without a project (it runs in
// the home folder; start a thread in the project) and for one that runs in its
// workspace's folder (leaving the workspace would leave it without a cwd).
func CheckMembersChange(s Thread) error {
	if len(s.Projects()) == 0 && s.WorkspaceID == "" {
		return fmt.Errorf("%w: thread %s has no project; start a thread in the project instead", ErrFailedPrecondition, s.ID)
	}
	if err := CheckWorkspaceChange(s, ""); err != nil {
		return fmt.Errorf("thread %s: %w", s.ID, err)
	}
	return nil
}

// memberByRef is the member of s that ref names: its id, else its project's name; ""
// when none. A member whose project is no longer registered is named by its id.
func (m *Manager) memberByRef(s Thread, ref string) (id, name string) {
	var snap *project.Snapshot
	if m.opts.Projects != nil {
		snap = m.opts.Projects.Snapshot()
	}
	for _, pid := range s.Projects() {
		r, ok := snap.Project(pid)
		if pid == ref || (ok && r.Name != "" && r.Name == ref) {
			return pid, cmp.Or(r.Name, pid)
		}
	}
	return "", ""
}

// placeMember is the checkout r gets as a new member of s (see above); made is the
// worktree it made, nil when it found one or uses a folder.
func (m *Manager) placeMember(ctx context.Context, s Thread, r project.Project) (string, *madeWorktree, error) {
	if !s.worktreeMode() || !r.Git {
		return mainCheckout(r), nil, nil
	}
	made, err := m.makeWorktrees(ctx, []project.Project{r}, s.Branch, func(string) string { return "" }, false, m.opts.BaseFromOrigin())
	if err != nil {
		return "", nil, err
	}
	if len(made) > 0 {
		return made[0].path, &made[0], nil
	}
	wt, ok := m.memberWorktree(r, s.Branch)
	if !ok {
		return "", nil, fmt.Errorf("%w: %s's worktree for %s was not found after it was made", ErrFailedPrecondition, r.Name, s.Branch)
	}
	return wt.Path, nil, nil
}

// changeMembers applies fn to thread id's row under the lock, refusing a thread that
// is closing or starting, and tells a live process its --add-dir list changed (a
// restart once it is quiet; noteMembers sends it). left is the workspace the thread
// stopped referencing, "" when it referenced none.
func (m *Manager) changeMembers(id string, fn func(Thread) (Thread, error)) (Thread, string, error) {
	m.mu.Lock()
	defer m.mu.Unlock()
	rec, err := m.record(id)
	if err != nil {
		return Thread{}, "", err
	}
	switch {
	case rec.s.State == StateClosing:
		return Thread{}, "", fmt.Errorf("%w: thread %s is closing", ErrFailedPrecondition, id)
	case rec.reserved != nil:
		return Thread{}, "", fmt.Errorf("%w: thread %s is starting; try again in a moment", ErrFailedPrecondition, id)
	}
	if err := CheckMembersChange(rec.s); err != nil {
		return Thread{}, "", err
	}
	next, err := fn(rec.s)
	if err != nil {
		return Thread{}, "", err
	}
	left := rec.s.WorkspaceID
	rec.s = next
	m.commitLocked(rec, true)
	return rec.s, left, nil
}

// WithMember is s with projectID added at path, detached from its workspace.
// Pure; the fake (threadtest) uses it too.
func WithMember(s Thread, projectID, path string) Thread {
	s.ProjectIDs = CleanProjectIDs(s.ProjectID, append(slices.Clone(s.ProjectIDs), projectID))
	s.WorkspaceID = ""
	return s.withCheckout(projectID, path)
}

// WithoutMember is s without projectID and its record, detached from its workspace;
// refused for the primary (the cwd) and for a member a queued Run in moves to. Pure.
func WithoutMember(s Thread, projectID, name string) (Thread, error) {
	if projectID == s.ProjectID {
		return s, fmt.Errorf("%w: %s is where thread %s runs; run it in another project first (thread run-in)", ErrFailedPrecondition, name, s.ID)
	}
	if p, ok := s.CheckoutPath(projectID); ok && s.PendingWorktreePath != "" && samePath(p, s.PendingWorktreePath) {
		return s, fmt.Errorf("%w: thread %s moves to %s once it is idle (thread run-in); move it elsewhere first", ErrFailedPrecondition, s.ID, name)
	}
	s.ProjectIDs = slices.DeleteFunc(CleanProjectIDs(s.ProjectID, s.ProjectIDs), func(id string) bool { return id == projectID })
	if s.CheckoutPaths != nil {
		paths := maps.Clone(s.CheckoutPaths)
		delete(paths, projectID)
		s.CheckoutPaths = paths
	}
	s.WorkspaceID = ""
	return s, nil
}

// workspaceName is workspace id's name, else the id; "" for "".
func (m *Manager) workspaceName(id string) string {
	if id == "" || m.opts.Workspaces == nil {
		return id
	}
	if w, ok := m.opts.Workspaces.Snapshot().Workspace(id); ok {
		return cmp.Or(w.Name, id)
	}
	return id
}

// addedNote and removedNote are the timeline lines for a set change; left is the
// workspace the thread no longer follows.
func addedNote(project, path string, made bool, left string) string {
	what := "checkout"
	if made {
		what = "new worktree"
	}
	return "Added project " + project + " to this thread (" + what + " " + path + ")." + leftNote(left)
}

func removedNote(project, path, left string) string {
	where := ""
	if path != "" {
		where = " Its checkout (" + path + ") stays on disk."
	}
	return "Removed project " + project + " from this thread." + where + leftNote(left)
}

func leftNote(workspace string) string {
	if workspace == "" {
		return ""
	}
	return " The thread no longer follows workspace " + workspace + ": its projects are its own set now."
}

// noteMembers writes the timeline note for a set change and, for a live thread, asks
// its runner for the restart that gives Claude the new --add-dir list. A thread without
// a process gets the note only: its next start passes the list.
func (m *Manager) noteMembers(ctx context.Context, id, text string) {
	it := Item{Kind: KindNote, Text: text}
	for {
		live, closing, reserved, _, err := m.lifecycle(id)
		if err != nil {
			return
		}
		switch {
		case live != nil:
			if _, err := live.call(ctx, threadCmd{verb: &it, dirs: true}); errors.Is(err, errProcessGone) {
				continue
			} else if err != nil {
				m.log.Warn("note a project set change", "thread", id, "err", err)
			}
			return
		case closing != nil:
			if waitDone(ctx, closing) != nil {
				return
			}
			continue
		case reserved != nil:
			select {
			case <-reserved:
			case <-ctx.Done():
				return
			}
			continue
		}
		log, err := m.thread(ctx, id)
		if err != nil {
			m.log.Warn("note a project set change", "thread", id, "err", err)
			return
		}
		w := itemWriter{log: log, save: func(it Item) { m.saveItem(id, it) }}
		it.ID = string(it.Kind) + "-" + itemSuffix()
		w.add(it)
		return
	}
}
