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
	m.noteMembers(ctx, id, addedNote(r.Name, path, made != nil, m.workspaceName(left)), liveAddNote)
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
	var dropped []LinkedPullRequest
	s, left, err := m.changeMembers(id, func(s Thread) (Thread, error) {
		if !slices.Contains(s.Projects(), pid) {
			return s, fmt.Errorf("%w: %s is not one of thread %s's projects", ErrFailedPrecondition, name, id)
		}
		path, _ = s.CheckoutPath(pid)
		next, err := WithoutMember(s, pid, name)
		if err != nil {
			return s, err
		}
		slug, others := m.memberSlugs(next, pid)
		next.LinkedPullRequests, dropped = dropBranchLinks(next.LinkedPullRequests, slug, others)
		return next, nil
	})
	if err != nil {
		return Thread{}, err
	}
	if len(dropped) > 0 && m.opts.DB != nil {
		urls := make([]string, len(dropped))
		for i, l := range dropped {
			urls[i] = l.URL
		}
		if err := deleteLinks(context.WithoutCancel(ctx), m.opts.DB, id, urls); err != nil {
			m.log.Error("forget the removed member's branch links", "thread", id, "err", err)
		}
	}
	m.log.Info("project removed from thread", "thread", id, "project", pid, "checkout", path, "left_workspace", left, "branch_links_dropped", len(dropped))
	m.noteMembers(ctx, id, removedNote(name, path, m.workspaceName(left)), liveRemoveNote(path))
	return s, nil
}

// CheckMembersChange refuses a set change for an archived thread (unarchive it first), a
// thread without a project (it runs in the home folder; start a thread in the project)
// and one that runs in its workspace's folder (leaving the workspace would leave it
// without a cwd).
func CheckMembersChange(s Thread) error {
	if !s.ArchivedAt.IsZero() {
		return fmt.Errorf("%w: thread %s is archived; unarchive it first", ErrFailedPrecondition, s.ID)
	}
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
	if rec.run != nil {
		rec.run.dirsStale.Store(true) // its next quiet moment restarts it (maybeRestart)
	}
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

// memberSlugs is removed's GitHub repository ("" when unknown) and the repositories of
// s's members (s is the thread without it).
func (m *Manager) memberSlugs(s Thread, removed string) (string, []string) {
	if m.opts.Projects == nil {
		return "", nil
	}
	snap := m.opts.Projects.Snapshot()
	r, _ := snap.Project(removed)
	var others []string
	for _, id := range s.Projects() {
		if p, ok := snap.Project(id); ok && p.GitHubSlug != "" {
			others = append(others, p.GitHubSlug)
		}
	}
	return r.GitHubSlug, others
}

// dropBranchLinks is links without the branch links (LinkBranch) a removed member gave
// the thread: those in its repository slug, unless another member works in the same
// repository (the daemon matches branch links by repository and branch, and keeps no
// project on the link). Links from Claude's records and from child threads stay; so does
// everything when the slug is unknown. Pure; copy on write.
func dropBranchLinks(links []LinkedPullRequest, slug string, others []string) (kept, dropped []LinkedPullRequest) {
	if slug == "" || slices.ContainsFunc(others, func(o string) bool { return strings.EqualFold(o, slug) }) {
		return links, nil
	}
	for _, l := range links {
		if l.Source == LinkBranch && strings.EqualFold(l.Slug, slug) {
			dropped = append(dropped, l)
		} else {
			kept = append(kept, l)
		}
	}
	if len(dropped) == 0 {
		return links, nil
	}
	return kept, dropped
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

// DirsRestartNote is the timeline's line once Claude restarted for a changed project set
// (effort.go onRestarted).
const DirsRestartNote = "Restarted Claude with the new project list"

// liveAddNote and liveRemoveNote end a set change's note while Claude runs: it gets the
// new list at its restart, and a removed folder stays one of its folders until then.
const liveAddNote = " Claude restarts with the new folders once it is idle."

func liveRemoveNote(path string) string {
	if path == "" {
		return liveAddNote
	}
	return " Claude restarts with the new folders once it is idle; until then " + path + " stays one of its folders."
}

// failedRestartNote follows a set change's note that could not reach the running
// Claude's runner: the restart still comes at its next idle (runner.dirsStale).
func failedRestartNote(err error) string {
	return "Could not restart Claude for the new project list: " + err.Error() + "; it retries when idle"
}

func leftNote(workspace string) string {
	if workspace == "" {
		return ""
	}
	return " The thread no longer follows workspace " + workspace + ": its projects are its own set now."
}

// noteMembers writes the timeline note for a set change: text, and for a live thread
// liveText after it (changeMembers flagged its runner for the restart). A note that cannot
// reach the runner is queued on it with the failure (noteFailed); a thread without a
// process gets the note in its log.
func (m *Manager) noteMembers(ctx context.Context, id, text, liveText string) {
	for {
		live, closing, reserved, _, err := m.lifecycle(id)
		if err != nil {
			return
		}
		switch {
		case live != nil:
			it := Item{Kind: KindNote, Text: text + liveText}
			if _, err := live.call(ctx, threadCmd{verb: &it}); errors.Is(err, errProcessGone) {
				continue
			} else if err != nil {
				m.noteFailed(live, it.Text, err)
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
		w.add(Item{ID: string(KindNote) + "-" + itemSuffix(), Kind: KindNote, Text: text})
		return
	}
}

// noteFailed queues a set change's note and the failure on the running thread's runner
// (its next maybeRestart writes them): the restart itself still comes at the next idle.
func (m *Manager) noteFailed(r *runner, text string, err error) {
	m.log.Warn("set change did not reach the running claude; it restarts at its next idle", "thread", r.id, "err", err)
	r.queueNote(text)
	r.queueNote(failedRestartNote(err))
}

// queueNote keeps a timeline line for the run goroutine (flushNotes). Any goroutine.
func (r *runner) queueNote(text string) {
	r.notesMu.Lock()
	r.notes = append(r.notes, text)
	r.notesMu.Unlock()
}

// flushNotes writes the queued lines (queueNote). Run goroutine.
func (r *runner) flushNotes() {
	r.notesMu.Lock()
	notes := r.notes
	r.notes = nil
	r.notesMu.Unlock()
	for _, t := range notes {
		r.st.proj.w.add(Item{ID: r.st.proj.nextID("note"), Kind: KindNote, Text: t})
	}
}
