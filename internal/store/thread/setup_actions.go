package thread

import (
	"context"
	"errors"
	"fmt"
	"slices"
	"strings"
	"time"

	"github.com/alexwaumann/code-foundry/internal/store/project"
)

// The ways out of a setup that did not finish (docs/notes/instant-threads-2-actions.md).
// The GUI's composer note offers them after a failure or a cancel, and Cancel during a
// setup:
//
//   - RetrySetup goes on at the step that failed, what is done staying done; after a cancel
//     it starts over, since nothing is left.
//   - CancelSetup stops a running setup and takes away what it made. It is the user's own
//     doing, so the thread settles idle, not in error.
//   - DiscardSetup undoes the send: the thread goes as if it had never been made, and the
//     composer gets back what it held.
//
// Remove ends one the same way as Discard but keeps its tombstone (removeOne). All of them
// clean up through cleanSetup, which goes through rollback's rules.
//
// A message sent during a setup is queued behind the first prompt (sendToSetup), and one
// sent after it failed or was cancelled tries it again too. It stays on the row, like the
// first prompt, until Claude has it.

// errSetupCancelled is how a setup stage stopped by CancelSetup ends.
var errSetupCancelled = errors.New("the setup was cancelled")

// SetupMessage is a message of a setup that never reached Claude.
type SetupMessage struct {
	Text, ComposerText string
	Attachments        []string
}

// SetupDraft is what DiscardSetup gives back to fill the composer again.
type SetupDraft struct {
	// DraftJSON is CreateOptions.DraftJSON, as it came.
	DraftJSON string
	// Error is why the setup failed; "" after a cancel.
	Error string
	// First is the first message, Queued those sent behind it, in order. The attachments
	// stay on disk.
	First  *SetupMessage
	Queued []SetupMessage
	// Kept are the worktrees that stayed because they have work in them.
	Kept []string
}

// message is p as a SetupMessage.
func (p PendingFirst) message() SetupMessage {
	m := SetupMessage{Text: p.Text, ComposerText: p.Composer}
	for _, a := range p.Attachments {
		m.Attachments = append(m.Attachments, a.Path)
	}
	return m
}

// options is the CreateOptions the setup of s ran with: r for what is not on the row. It
// always runs in the background: a caller that waited has its answer.
func (r *SetupRequest) options(s Thread) CreateOptions {
	return CreateOptions{ProjectID: r.ProjectID, WorktreePath: r.WorktreePath, ProjectIDs: slices.Clone(r.ProjectIDs), Like: r.Like,
		NewBranch: r.NewBranch, CheckoutMode: r.CheckoutMode, WorkspaceID: r.WorkspaceID, NoProject: r.NoProject, Cwd: r.Cwd,
		ResumeSession: r.ResumeSession, NewWorktree: r.NewWorktree, Name: r.Name, InitialPrompt: r.InitialPrompt,
		ComposerPrompt: r.ComposerPrompt, Attachments: slices.Clone(r.Attachments), Notify: r.Notify, NotifyGroup: r.NotifyGroup, NotifyRepeat: r.NotifyRepeat, DraftJSON: r.DraftJSON,
		Model: s.Model, Effort: s.Effort, PermissionMode: s.PermissionMode, CreatedBy: s.CreatedBy, Brief: s.Brief,
		Labels: slices.Clone(s.Labels), BudgetUSD: s.BudgetUSD, Owner: s.Owner, Env: slices.Clone(s.SpawnEnv),
		AddDirs: slices.Clone(s.SpawnAddDirs), SystemPromptAppend: s.SystemPromptAppend, BackgroundSetup: true}
}

// retryRefusal says why rec's setup cannot run again; nil when it can.
func (m *Manager) retryRefusal(rec *record) error {
	s := rec.s
	switch {
	case m.closed:
		return ErrClosed
	case s.Setup == nil || s.Setup.Phase == SetupDone:
		return fmt.Errorf("%w: thread %s has no setup to try again", ErrFailedPrecondition, s.ID)
	case s.SettingUp() || rec.setup != nil:
		return fmt.Errorf("%w: thread %s is still being set up", ErrFailedPrecondition, s.ID)
	case s.Removing:
		return fmt.Errorf("%w: thread %s is being removed", ErrFailedPrecondition, s.ID)
	case s.Setup.Request == nil:
		return fmt.Errorf("%w: thread %s kept nothing to try its setup again with", ErrFailedPrecondition, s.ID)
	}
	return nil
}

// RetrySetup implements Store.
func (m *Manager) RetrySetup(ctx context.Context, id string) (Thread, error) {
	m.mu.Lock()
	rec, err := m.record(id)
	if err == nil {
		err = m.retryRefusal(rec)
	}
	var j *setupJob
	if err == nil {
		j, err = m.beginRetryLocked(rec)
	}
	m.mu.Unlock()
	if err != nil {
		return Thread{}, err
	}
	m.runRetry(j)
	return m.Get(ctx, id)
}

// beginRetryLocked puts rec's setup back to running, with a reservation as Create's has,
// and registers a stage for it; the caller checked retryRefusal and calls runRetry after
// m.mu. A retry brings the thread back to the list, as a message does. Callers hold m.mu.
func (m *Manager) beginRetryLocked(rec *record) (*setupJob, error) {
	s := &rec.s
	cid, err := newUUID()
	if err != nil {
		return nil, err
	}
	o := s.Setup.Request.options(*s)
	l := launch{newID: cid}
	if o.ResumeSession != "" {
		l = launch{resume: o.ResumeSession, fork: true, newID: cid, freshPrompt: true}
	}
	var attachments []attachment
	if s.PendingFirst != nil {
		attachments = s.PendingFirst.outgoing().attachments
	}
	// Its Prompt may be the last run's, rewritten for worktrees that are gone by now:
	// landPlacement writes this one over it.
	prompt := buildPrompt(o.InitialPrompt, attachments)
	j := &setupJob{id: s.ID, creatorID: s.CreatedBy, o: o, prompt: prompt, l: l, retry: true, fromStart: s.Setup.Phase == SetupCancelled}
	now := m.opts.Now()
	s.Setup = s.Setup.retried(now)
	s.setStatus(StatusBusy, ReasonSettingUp, now)
	s.DisconnectReason, s.LastError = "", ""
	m.unarchiveLocked(rec)
	m.unsnoozeLocked(rec)
	rec.reserve()
	m.registerSetupLocked(context.Background(), rec, j)
	m.commitLocked(rec, true)
	return j, nil
}

// runRetry takes back the turn end the last run wrote, which would otherwise close the
// turn this run answers, and that a wait would count as the answer, then starts the stage.
func (m *Manager) runRetry(j *setupJob) {
	if log, err := m.thread(context.Background(), j.id); err != nil {
		m.log.Warn("reopen the turn of a retried setup", "thread", j.id, "err", err)
	} else if id, ok := log.lastSynthTurn(); ok {
		if err := deleteItem(context.Background(), m.opts.DB, j.id, id); err != nil {
			m.log.Error("delete the turn end of a retried setup", "thread", j.id, "err", err)
		}
		log.dropItem(id)
	}
	go func() { _ = m.finishSetup(j) }()
}

// setupResume is what a retried setup keeps of the run before: the branch once named and
// whether it existed then, the worktrees made, the projects whose branch the run made
// (own), the fetches that ended. A nil one is a first run.
type setupResume struct {
	branch   string
	existing bool
	made     []madeWorktree
	own      map[string]bool
	fetched  map[string]bool
}

// named reports whether the run before named the branch.
func (r *setupResume) named() bool { return r != nil && r.branch != "" }

// has reports whether the run before made project id's worktree.
func (r *setupResume) has(id string) bool {
	return r != nil && slices.ContainsFunc(r.made, func(w madeWorktree) bool { return w.projectID == id })
}

// left are the projects of todo with no worktree yet.
func (r *setupResume) left(todo []project.Project) []project.Project {
	return slices.DeleteFunc(slices.Clone(todo), func(p project.Project) bool { return r.has(p.ID) })
}

// fetchedIn reports whether the run before fetched project id.
func (r *setupResume) fetchedIn(id string) bool { return r != nil && r.fetched[id] }

// unfetched are the projects of todo with their fetch still to do.
func (r *setupResume) unfetched(todo []project.Project) []project.Project {
	return slices.DeleteFunc(slices.Clone(todo), func(p project.Project) bool { return r.fetchedIn(p.ID) })
}

// withMade is made with the worktrees of the run before.
func (r *setupResume) withMade(made []madeWorktree) []madeWorktree {
	if r == nil {
		return made
	}
	out := append(slices.Clone(r.made), made...)
	slices.SortFunc(out, func(a, b madeWorktree) int { return strings.Compare(a.projectID, b.projectID) })
	return out
}

// resumeOf reads what s's run left, and forgets worktrees that went since (by hand, or
// with an archive), so their steps run again.
func resumeOf(s Thread) (r *setupResume, gone []string) {
	r = &setupResume{fetched: map[string]bool{}, own: map[string]bool{}}
	for _, st := range s.Setup.Steps {
		switch {
		case st.Kind == SetupStepName && st.Status == SetupStepDone:
			r.branch, r.existing = st.Branch, st.Existing
		case st.Kind == SetupStepFetch && (st.Status == SetupStepDone || st.Status == SetupStepWarning):
			r.fetched[st.ProjectID] = true
		}
	}
	for _, w := range madeOf(s.Setup) {
		r.own[w.projectID] = w.ownBranch
		if isDir(w.path) {
			r.made = append(r.made, w)
		} else {
			gone = append(gone, w.projectID)
		}
	}
	return r, gone
}

// resumeBranch is the branch a retried setup goes on, and whether it is there to check
// out, as pickBranch decides for a first run. A name stays what it was while it still means
// what it did. But a new branch has no reservation between runs, so it may exist by now,
// and not by this setup's doing (the projects it made it in do not count):
//
//   - One the user typed is taken as existing, its base dropped, as a first run would take
//     it now. So a thread there already is shared: asking for a branch by name asks for
//     that, and it is what thread.new --branch does.
//   - A generated one was never asked for, and whoever has it is unrelated work: the setup
//     picks again, as if it had come second the first time, starting over with what it made
//     on the old name, since one thread has one branch.
func (m *Manager) resumeBranch(ctx context.Context, w *worktreePlan, t *setupTracker) (branch string, existing bool, release func(), err error) {
	r := w.resume
	none := func() {}
	if r.existing {
		return r.branch, true, none, nil
	}
	var all, others []string
	for _, p := range w.git {
		all = append(all, p.Path)
		if !r.own[p.ID] {
			others = append(others, p.Path)
		}
	}
	if strings.TrimSpace(w.nw.Branch) != "" {
		existing = m.userBranchExists(ctx, others, r.branch)
		t.renamed(r.branch, existing)
		return r.branch, existing, none, nil
	}
	if release, ok := m.reserveBranch(others, r.branch); ok {
		if !m.branchExists(ctx, others, r.branch) {
			return r.branch, false, release, nil
		}
		release()
	}
	m.log.Info("the branch a failed setup named was taken meanwhile; picking another", "thread", w.id, "branch", r.branch)
	if kept := m.rollback(ctx, w.id, r.made); len(kept) > 0 {
		return "", false, none, fmt.Errorf("%w: branch %s was taken meanwhile, and %s has work on it", ErrFailedPrecondition, r.branch, strings.Join(kept, ", "))
	}
	lost := make([]string, len(r.made))
	for i, made := range r.made {
		lost[i] = made.projectID
	}
	t.lost(lost)
	r.made, r.own = nil, map[string]bool{}
	branch, existing, release = m.pickBranch(ctx, all, w.bc, r.branch, w.id)
	r.branch, r.existing = branch, existing
	t.renamed(branch, existing)
	return branch, existing, release, nil
}

// replan decides what a retried setup still has to do. A placement that landed stands,
// with its worktrees on disk: only the start is left. Anything else is planned as Create
// planned it, which can fail now where it did not then (a Like that is gone): the setup
// then fails, and says so. An add the daemon lost goes first: it is in the way.
func (m *Manager) replan(j *setupJob, t *setupTracker) error {
	s, ok := m.Snapshot().Thread(j.id)
	if !ok {
		return m.notFound(j.id)
	}
	left, _ := m.abandonAdds(j.ctx, s)
	t.edit(func(c *Setup, _ time.Time) { c.Adding = left }) // what stays fails the add, and says so
	if s.WorktreePath != "" && isDir(s.WorktreePath) && m.requireCheckouts(s) == nil {
		j.p = placedOf(s)
		return nil
	}
	if s.WorktreePath != "" {
		m.update(j.id, true, func(r *record) { r.s.unplace() })
	}
	m.refreshProjects(j.ctx, s)
	name, err := cleanName(j.o.Name, true)
	if err != nil {
		return err
	}
	p, w, err := m.planThread(j.ctx, j.id, name, s.CreatedBy, j.o)
	if err != nil {
		return err
	}
	j.p, j.w = p, w
	if j.fromStart {
		steps := m.setupSteps(w)
		t.edit(func(c *Setup, _ time.Time) { c.Steps, c.Held = steps, w.sharedPaths() })
		return nil
	}
	if w != nil {
		var gone []string
		w.resume, gone = resumeOf(s)
		t.lost(gone)
	}
	return nil
}

// refreshProjects reads s's projects again: whoever tries a setup again has often just
// fixed what stopped it, and the snapshot may not have seen that yet.
func (m *Manager) refreshProjects(ctx context.Context, s Thread) {
	if m.opts.Projects == nil {
		return
	}
	for _, id := range s.Projects() {
		if err := m.opts.Projects.Refresh(ctx, id); err != nil && !errors.Is(err, project.ErrNotFound) {
			m.log.Warn("refresh a project for a retried setup", "thread", s.ID, "project", id, "err", err)
		}
	}
}

// placedOf is the placement that landed on s. A name step that ended means the namer ran,
// which a restart has forgotten: it does not run again once Claude has the message.
func placedOf(s Thread) placedThread {
	st := s.Setup.step(SetupStepName, "")
	return placedThread{projectIDs: s.ProjectIDs, projectID: s.ProjectID, path: s.WorktreePath, baseRef: s.BaseRef, branch: s.Branch,
		createdWorktree: s.CreatedWorktree, workspaceID: s.WorkspaceID, checkouts: s.CheckoutPaths, made: madeOf(s.Setup),
		namerCalled: st != nil && st.Status == SetupStepDone}
}

// lost forgets the worktrees of projects ids and makes their steps pending again.
func (t *setupTracker) lost(ids []string) {
	if len(ids) == 0 {
		return
	}
	t.edit(func(s *Setup, _ time.Time) {
		s.Made = slices.DeleteFunc(s.Made, func(w SetupWorktree) bool { return slices.Contains(ids, w.ProjectID) })
		for _, id := range ids {
			if st := s.step(SetupStepWorktree, id); st != nil {
				st.reset()
			}
		}
	})
}

// cancelRefusal says why rec's setup cannot be cancelled; nil when it can.
func cancelRefusal(rec *record) error {
	s := rec.s
	switch {
	case s.Setup == nil:
		return fmt.Errorf("%w: thread %s has no setup to cancel", ErrFailedPrecondition, s.ID)
	case s.Setup.Phase == SetupDone:
		return fmt.Errorf("%w: thread %s finished its setup: it was too late to cancel it, and Claude is starting; interrupt it instead", ErrFailedPrecondition, s.ID)
	case !s.SettingUp():
		return fmt.Errorf("%w: thread %s's setup is not running", ErrFailedPrecondition, s.ID)
	case !s.Setup.Background:
		return fmt.Errorf("%w: thread %s's creator is waiting for its setup; stop that call instead", ErrFailedPrecondition, s.ID)
	case rec.setup == nil:
		return fmt.Errorf("%w: thread %s's setup has not begun yet", ErrFailedPrecondition, s.ID)
	}
	return nil
}

// CancelSetup implements Store. spawn's commit and settleSetup decide the race with a
// setup landing or failing as it is asked, under m.mu, so it ends one way or the other:
// the stage stops and leaves nothing, or the cancel is told it came too late.
func (m *Manager) CancelSetup(ctx context.Context, id string) (Thread, []string, error) {
	m.mu.Lock()
	rec, err := m.record(id)
	if err == nil {
		err = cancelRefusal(rec)
	}
	if err != nil {
		m.mu.Unlock()
		return Thread{}, nil, err
	}
	j := rec.setup
	j.cancelAsked = !j.settled
	m.mu.Unlock()
	j.cancel()
	select {
	case <-j.done:
	case <-ctx.Done():
		return Thread{}, nil, ctx.Err()
	}
	s, err := m.Get(ctx, id)
	if err != nil {
		return Thread{}, nil, err
	}
	if s.Setup.Phase != SetupCancelled {
		return s, nil, fmt.Errorf("%w: thread %s's setup failed before it could be cancelled: %s", ErrFailedPrecondition, id, s.Setup.Error)
	}
	return s, j.kept, nil
}

// endCancelled settles a cancelled stage: what it made goes before the thread says so, and
// the placement goes with it when it had worktrees.
func (m *Manager) endCancelled(j *setupJob) {
	j.kept = m.cleanSetup(j.ctx, j.id)
	m.closeSetupTurn(j.id)
	now := m.opts.Now()
	m.update(j.id, true, func(r *record) {
		r.release()
		r.first = nil
		if j.w != nil || r.s.CreatedWorktree {
			r.s.unplace()
		}
		r.s.cancelSetup(now)
	})
	m.log.Info("thread setup cancelled", "thread", j.id, "kept", len(j.kept))
}

// DiscardSetup implements Store.
func (m *Manager) DiscardSetup(ctx context.Context, id string) (SetupDraft, error) {
	m.mu.Lock()
	rec, err := m.record(id)
	switch {
	case err != nil:
	case !rec.s.setupStopped() || rec.setup != nil:
		err = fmt.Errorf("%w: only a failed or cancelled setup can be discarded; thread %s has none", ErrFailedPrecondition, id)
	case rec.s.Removing:
		err = fmt.Errorf("%w: thread %s is being removed", ErrFailedPrecondition, id)
	}
	if err != nil {
		m.mu.Unlock()
		return SetupDraft{}, err
	}
	s := rec.s
	rec.s.Removing = true
	m.commitLocked(rec, false)
	m.mu.Unlock()
	if err := m.removeShells(ctx, id, ShellsRemoved); err != nil {
		_ = m.setRemoving(id, false)
		return SetupDraft{}, err
	}
	d := SetupDraft{Error: s.Setup.Error}
	if s.Setup.Request != nil {
		d.DraftJSON = s.Setup.Request.DraftJSON
	}
	if s.PendingFirst != nil {
		first := s.PendingFirst.message()
		d.First = &first
	}
	for _, q := range s.Setup.Queued {
		d.Queued = append(d.Queued, q.message())
	}
	d.Kept = m.cleanSetup(ctx, id)
	m.discardCreate(id)
	return d, nil
}

// cleanSetup removes what thread id's unfinished setup made and has not lost hold of, and
// returns the worktrees it left for the work in them. The one way any end of a setup
// cleans up. No stage may be running; a call with nothing to do does nothing.
func (m *Manager) cleanSetup(ctx context.Context, id string) []string {
	s, ok := m.Snapshot().Thread(id)
	if !ok || !s.setupUnfinished() || (len(s.Setup.Made) == 0 && len(s.Setup.Adding) == 0) {
		return nil
	}
	kept := m.rollback(ctx, id, madeOf(s.Setup))
	_, stayed := m.abandonAdds(ctx, s)
	m.update(id, true, func(r *record) {
		r.s.Setup = r.s.Setup.edit(func(c *Setup) { c.Made, c.Adding = nil, nil })
	})
	return append(kept, stayed...)
}

// abandonAdds removes what the adds on s's record left, unless a thread has the path by
// now. Only the daemon's death leaves one there. left are the adds that could not be
// undone, and stayed their paths still on disk.
func (m *Manager) abandonAdds(ctx context.Context, s Thread) (left []SetupAdd, stayed []string) {
	ctx = context.WithoutCancel(ctx)
	for _, a := range s.Setup.Adding {
		if m.abandonAdd(ctx, s.ID, a) {
			continue
		}
		left = append(left, a)
		if pathExists(a.Path) {
			stayed = append(stayed, a.Path)
		}
	}
	return left, stayed
}

// abandonAdd is abandonAdds for a, under the lock that makes or shares its worktree; false
// when it could not.
func (m *Manager) abandonAdd(ctx context.Context, id string, a SetupAdd) bool {
	unlock, err := m.lockWorktree(ctx, a.ProjectID, a.Branch)
	if err != nil {
		return false
	}
	defer unlock()
	if who, held := m.heldElsewhere(id, a.Path); held {
		m.log.Info("half-made worktree left: another thread has the path", "thread", id, "path", a.Path, "holder", who)
		return true
	}
	o := project.AbandonWorktreeOptions{ProjectID: a.ProjectID, Path: a.Path, Branch: a.Branch, Head: a.Head}
	if m.branchHeld(id, a.ProjectID, a.Branch) {
		o.Head = "" // another thread's, as in rollbackOne
	}
	if err := m.opts.Projects.AbandonWorktree(ctx, o); err != nil {
		m.log.Warn("remove what a lost worktree add left", "thread", id, "project", a.ProjectID, "path", a.Path, "err", err)
		return false
	}
	return true
}

// discardUnmadeTimeout bounds how long the threads of Creates lost with the daemon wait
// for their projects to list worktrees.
const discardUnmadeTimeout = 2 * time.Minute

// startDiscardingUnmade discards the threads whose waited-for Create died with the daemon
// (New keeps them, Removing, until then): cleanup needs the worktrees listed, which comes
// after the start. A daemon death before it ends finds the rows as they were.
func (m *Manager) startDiscardingUnmade(ids []string) {
	if len(ids) == 0 {
		return
	}
	m.wg.Add(1)
	go func() {
		defer m.wg.Done()
		m.untilDecided(ids, m.opts.Tick, discardUnmadeTimeout, m.discardListed, func(left []string) {
			m.log.Warn("threads discarded without their cleanup: their projects did not list worktrees", "threads", len(left))
			for _, id := range left {
				m.discardCreate(id)
			}
		})
	}()
}

// discardListed discards those of pending whose projects list their worktrees, and
// returns the rest.
func (m *Manager) discardListed(pending []string) []string {
	var left []string
	for _, id := range pending {
		s, ok := m.Snapshot().Thread(id)
		if ok && !m.setupProjectsListed(s) {
			left = append(left, id)
			continue
		}
		m.cleanSetup(m.ctx, id)
		m.discardCreate(id)
	}
	return left
}

// setupProjectsListed reports whether the projects of what s's setup made have listed
// their worktrees. A project that is gone will not.
func (m *Manager) setupProjectsListed(s Thread) bool {
	if m.opts.Projects == nil {
		return true
	}
	snap := m.opts.Projects.Snapshot()
	listed := func(id string) bool {
		r, ok := snap.Project(id)
		return !ok || !r.Git || len(r.Worktrees) > 0
	}
	return !slices.ContainsFunc(s.Setup.Made, func(w SetupWorktree) bool { return !listed(w.ProjectID) }) &&
		!slices.ContainsFunc(s.Setup.Adding, func(a SetupAdd) bool { return !listed(a.ProjectID) })
}

// createFailed reports whether thread id, gone from the store, went because its Create
// failed: a thread that was removed left a tombstone.
func (m *Manager) createFailed(id string) bool {
	_, removed := m.removed.get(id, m.opts.Now())
	return !removed
}

// refuseToSetup is the refusal of msg to thread id during or after a setup. A message
// from the user or another thread is taken. A wake is no reason to try again, and one
// whose creator waits for it is refused: that thread may yet never have been made.
func (m *Manager) refuseToSetup(id string, msg Message) error {
	t, ok := m.Snapshot().Thread(id)
	if !ok || !t.setupUnfinished() {
		return nil
	}
	if msg.Origin != OriginUser || (t.SettingUp() && !t.Setup.Background) {
		return setupRefusal(t, "sent to")
	}
	return nil
}

// sendToSetup takes a message for a thread whose setup has not finished: its item goes in
// the timeline as queued, and the message goes on the row behind the first prompt. After
// a failure or a cancel it also tries the setup again. handled is false when the setup got
// past spawn meanwhile: the message then goes to the process under the item written here.
func (m *Manager) sendToSetup(ctx context.Context, id string, log *threadLog, o *outgoing) (it Item, handled bool, err error) {
	w := itemWriter{log: log, save: func(it Item) { m.saveItem(id, it) }}
	if o.itemID, err = newUUID(); err != nil {
		return Item{}, false, err
	}
	log.holdQueued(o.itemID)
	u := userItem(o.itemID, o)
	u.Queued = true
	it = w.add(u)
	queue := func(rec *record) {
		rec.s.Setup = rec.s.Setup.edit(func(c *Setup) { c.Queued = append(c.Queued, *pendingFirstOf(o)) })
	}
	m.mu.Lock()
	rec, err := m.record(id)
	var j *setupJob
	switch {
	case err != nil:
	case rec.s.SettingUp():
		queue(rec)
		m.commitLocked(rec, true)
		m.mu.Unlock()
		return it, true, nil
	case rec.s.setupStopped():
		if err = m.retryRefusal(rec); err == nil {
			queue(rec)
			j, err = m.beginRetryLocked(rec)
		}
	default:
		m.mu.Unlock()
		log.releaseQueued(o.itemID) // not the row's: the process has it from here
		return it, false, nil
	}
	m.mu.Unlock()
	if err != nil {
		log.releaseQueued(o.itemID)
		if deleteItem(ctx, m.opts.DB, id, it.ID) == nil {
			log.dropItem(it.ID) // refused: it did not land
		}
		return Item{}, true, err
	}
	m.runRetry(j)
	return it, true, nil
}

// rewriteQueued rewrites the references of the messages sent during s's setup among msgs
// for its placement, which they were sent without.
func (m *Manager) rewriteQueued(s Thread, msgs []*outgoing) {
	for _, o := range msgs {
		if !o.setupQueued {
			continue
		}
		prompt, dropped := rewriteFileRefs(o.prompt, m.fileRefRoots(s))
		if len(dropped) > 0 {
			m.log.Warn("file references outside the thread's projects; passing their relative paths", "thread", s.ID, "refs", dropped)
		}
		o.prompt = m.rewriteThreadRefsLogged(s.ID, prompt, o.composer)
	}
}

// lateMessages are the messages on s's row that are not in have: sent while spawn started
// the process.
func lateMessages(s Thread, have []*outgoing) []*outgoing {
	if s.Setup == nil {
		return nil
	}
	var out []*outgoing
	for i := range s.Setup.Queued {
		q := &s.Setup.Queued[i]
		if !slices.ContainsFunc(have, func(o *outgoing) bool { return o.itemID == q.ItemID }) {
			out = append(out, q.queuedOutgoing())
		}
	}
	return out
}

// clearSetupQueued takes message itemID off thread id's row: it went out.
func (m *Manager) clearSetupQueued(id, itemID string) {
	m.mu.Lock()
	defer m.mu.Unlock()
	rec, ok := m.recs[id]
	if !ok || rec.s.Setup == nil {
		return
	}
	rec.s.Setup = rec.s.Setup.edit(func(c *Setup) {
		c.Queued = slices.DeleteFunc(c.Queued, func(q PendingFirst) bool { return q.ItemID == itemID })
	})
	m.commitLocked(rec, true)
}

// dropSetupQueued forgets the messages still on the row: their process ended without them.
func (t *Thread) dropSetupQueued() {
	if t.Setup != nil && len(t.Setup.Queued) > 0 {
		t.Setup = t.Setup.edit(func(c *Setup) { c.Queued = nil })
	}
}
