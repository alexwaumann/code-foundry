package thread

import (
	"cmp"
	"context"
	"errors"
	"fmt"
	"strings"

	"github.com/alexwaumann/code-foundry/internal/bus"
)

// The setup stage of Create (setup.go): the same work whether the caller waits for it or
// not. A caller that waits gets today's contract: a failure removes what was made and the
// thread, and is the call's error. One that does not (CreateOptions.BackgroundSetup) gets
// the thread at once; a failure stays on it, with what it made.

// setupJob is one Create's setup stage.
type setupJob struct {
	id        string
	creatorID string
	o         CreateOptions
	// p is the placement as the fast stage left it, and w the worktrees still to make
	// (nil: none).
	p placedThread
	w *worktreePlan
	// prompt is the first message as Claude gets it, before its references are rewritten
	// (they need the worktrees); "" without one.
	prompt string
	l      launch
	// ctx ends when the setup should stop: the caller left (when it waits), the thread is
	// being removed (stopSetup), the Manager shuts down. cancel and stopWatch release it.
	ctx       context.Context
	cancel    context.CancelFunc
	stopWatch func() bool
	// done closes when the setup stage has ended, its tail included.
	done chan struct{}
	// made are the worktrees of a placement that landed, for a caller's rollback.
	made []madeWorktree
}

// beginSetup registers the setup stage on the thread, tracked by Shutdown. The caller's
// ctx bounds it only when the caller waits for it. ErrClosed once Shutdown began.
func (m *Manager) beginSetup(ctx context.Context, j *setupJob) error {
	if j.o.BackgroundSetup {
		ctx = context.WithoutCancel(ctx)
	}
	j.ctx, j.cancel = context.WithCancel(ctx)
	j.stopWatch = context.AfterFunc(m.ctx, j.cancel)
	j.done = make(chan struct{})
	m.mu.Lock()
	defer m.mu.Unlock()
	rec, err := m.record(j.id)
	if err == nil && m.closed {
		err = ErrClosed
	}
	if err != nil {
		j.stopWatch()
		j.cancel()
		return err
	}
	rec.setup = j
	m.wg.Add(1)
	return nil
}

// finishSetup runs a registered setup stage to its end and settles a failure.
func (m *Manager) finishSetup(j *setupJob) error {
	defer m.wg.Done()
	defer close(j.done)
	defer j.cancel()
	defer j.stopWatch()
	defer m.clearSetup(j.id)
	report, err := m.runSetup(j)
	if err == nil {
		if j.o.Report != nil && !j.o.BackgroundSetup {
			*j.o.Report = report
		}
		return nil
	}
	stopping := m.ctx.Err() != nil || errors.Is(err, ErrClosed)
	if !j.o.BackgroundSetup {
		return m.failWaitedSetup(j, err, stopping)
	}
	if stopping {
		// The row stays as it is: the next start tells the thread (New).
		m.releaseSetup(j.id)
		m.log.Info("the daemon stopped during a thread's setup; it fails at the next start", "thread", j.id)
		return err
	}
	m.log.Warn("thread setup failed", "thread", j.id, "err", err)
	m.failSetup(j.id, err)
	if s, ok := m.Snapshot().Thread(j.id); ok && s.Removing {
		m.rollback(j.ctx, madeOf(s.Setup)) // going with the thread: nothing else knows them
	}
	return err
}

// failWaitedSetup settles a failure of a setup its caller waits for: what it made goes,
// and so does the thread, as if the Create had never made it (unless a Remove has it).
func (m *Manager) failWaitedSetup(j *setupJob, err error, stopping bool) error {
	m.rollback(j.ctx, j.made)
	if s, ok := m.Snapshot().Thread(j.id); ok && s.Removing {
		m.failSetup(j.id, err)
		return fmt.Errorf("%w: thread %s was removed during its setup", ErrFailedPrecondition, j.id)
	}
	m.discardCreate(j.id)
	if stopping {
		return ErrClosed
	}
	return err
}

// clearSetup forgets thread id's setup stage: it has ended.
func (m *Manager) clearSetup(id string) {
	m.mu.Lock()
	defer m.mu.Unlock()
	if rec, ok := m.recs[id]; ok {
		rec.setup = nil
	}
}

// releaseSetup ends thread id's reservation without touching it.
func (m *Manager) releaseSetup(id string) {
	m.mu.Lock()
	defer m.mu.Unlock()
	if rec, ok := m.recs[id]; ok {
		rec.release()
	}
}

// failSetup ends thread id's setup with err: its message's turn never ran, so it ends
// here, and the thread settles with the reason.
func (m *Manager) failSetup(id string, err error) {
	why := setupWhy(id, err)
	if log, lerr := m.thread(context.Background(), id); lerr == nil {
		closeOpenTurn(itemWriter{log: log, save: func(it Item) { m.saveItem(id, it) }}, m.opts.Now())
	} else {
		m.log.Warn("close the turn of a failed setup", "thread", id, "err", lerr)
	}
	now := m.opts.Now()
	m.update(id, true, func(r *record) {
		r.release()
		r.first = nil
		r.s.failSetup(now, why)
	})
}

// madeOf is what a setup recorded as made, as a rollback takes it.
func madeOf(s *Setup) []madeWorktree {
	if s == nil {
		return nil
	}
	out := make([]madeWorktree, len(s.Made))
	for i, w := range s.Made {
		out[i] = madeWorktree{projectID: w.ProjectID, path: w.Path, branch: w.Branch, newBranch: w.NewBranch, startPoint: w.StartPoint}
	}
	return out
}

// discardCreate forgets a thread whose Create failed: its record, its row and everything
// that went with it, with a Removed so clients drop what they showed. No tombstone: as far
// as anyone is told, the thread was never made.
func (m *Manager) discardCreate(id string) {
	m.mu.Lock()
	defer m.mu.Unlock()
	rec, ok := m.recs[id]
	if !ok {
		return
	}
	rec.release()
	if err := retireThread(context.Background(), m.opts.DB, id, nil); err != nil {
		m.log.Error("delete the row of a failed create", "thread", id, "err", err)
	}
	delete(m.recs, id)
	m.tmu.Lock()
	delete(m.threads, id) // the thread's log
	m.tmu.Unlock()
	m.rebuildLocked()
	bus.Publish[Event](m.opts.Bus, Removed{ID: id})
	m.forgetLocked(id, "not created")
	m.releaseHeldLocked(rec.s.CreatedBy) // a lead's wake held for this child (subscriptions_hold.go)
	m.removeThreadTmp(id)
}

// runSetup is the setup stage: the worktrees (the branch named meanwhile), the placement
// on the row, the prompt rewritten for it, Claude, then what follows a start.
func (m *Manager) runSetup(j *setupJob) (CreateReport, error) {
	var report CreateReport
	t := &setupTracker{m: m, id: j.id, keep: j.o.BackgroundSetup}
	p := j.p
	if j.w != nil {
		var err error
		if p, err = m.placeWorktrees(j.ctx, p, j.w, t); err != nil {
			return report, err
		}
		j.made = p.made
	}
	report = CreateReport{MadeWorktree: p.madePrimary, MadeBranch: p.madeBranch, ExistingWorktree: p.reusedPrimary, DroppedWorktreeMode: p.droppedWorktreeMode}
	if s, ok := m.Snapshot().Thread(j.id); ok && s.Removing {
		// A Remove stopped it: no Claude to start for a thread that is going.
		return report, fmt.Errorf("%w: thread %s is being removed", ErrFailedPrecondition, j.id)
	}
	m.landPlacement(j, p)
	t.begin(SetupStepStart, "")
	if err := m.spawn(j.ctx, j.id, j.l); err != nil {
		return report, err
	}
	if p.late != nil {
		m.applyLateName(j.id, p.late)
	}
	if m.opts.WorktreeCreated != nil {
		// Every worktree placement made runs its project's on-worktree-create actions.
		for _, w := range p.made {
			m.opts.WorktreeCreated(j.id, w.projectID, w.path)
		}
	}
	if j.o.Notify {
		m.notifyCreator(j.ctx, j.creatorID, j.id)
	}
	if report.ExistingWorktree {
		if other, ok := m.otherHolder(j.id, p.path); ok {
			report.SharedWith = holderLabel(other)
		}
	}
	return report, nil
}

// landPlacement puts a carried out placement on the row and the worktrees' paths in the
// first message (filerefs.go, threadrefs.go).
func (m *Manager) landPlacement(j *setupJob, p placedThread) {
	s, _ := m.Snapshot().Thread(j.id)
	placed := p.apply(s)
	prompt := j.prompt
	if prompt != "" {
		var dropped []string
		prompt, dropped = rewriteFileRefs(prompt, m.fileRefRoots(placed))
		if len(dropped) > 0 {
			m.log.Warn("file references outside the thread's projects; passing their relative paths",
				"thread", j.id, "project", placed.ProjectID, "workspace", placed.WorkspaceID, "refs", dropped)
		}
		prompt = m.rewriteThreadRefsLogged(j.id, prompt, j.o.ComposerPrompt)
	}
	m.update(j.id, true, func(r *record) {
		r.s = p.apply(r.s)
		r.namingTried = r.namingTried || p.namerCalled
		if p.name != "" {
			r.s.applyNamerTitle(p.name)
		}
		if f := r.s.PendingFirst; f != nil {
			c := *f
			c.Prompt = prompt
			r.s.PendingFirst = &c
		}
	})
}

// apply is s with the placement's fields.
func (p placedThread) apply(s Thread) Thread {
	s.ProjectID, s.ProjectIDs, s.WorktreePath, s.WorkspaceID = p.projectID, p.projectIDs, p.path, p.workspaceID
	s.CheckoutPaths = p.checkouts
	s.BaseRef, s.CreatedWorktree, s.Branch = p.baseRef, p.createdWorktree, p.branch
	s.ProjectIDs = CleanProjectIDs(s.ProjectID, s.ProjectIDs)
	if s.ProjectID != "" && s.WorktreePath != "" {
		s = s.withCheckout(s.ProjectID, s.WorktreePath) // the primary's is the cwd
	}
	return s
}

// setupSteps are the steps a setup starts with, every one pending. No worktree work: the
// one start step.
func (m *Manager) setupSteps(w *worktreePlan) []SetupStep {
	pending := func(st SetupStep) SetupStep {
		st.Status = SetupStepPending
		return st
	}
	var out []SetupStep
	if w != nil {
		if w.pl.newBranch {
			out = append(out, pending(SetupStep{Kind: SetupStepName}))
		}
		for _, r := range w.todo() {
			if !w.pl.newBranch {
				if _, ok := m.memberWorktree(r, w.pl.branch); ok {
					continue // made already, by the thread it copies or by hand
				}
			}
			if !w.pl.newBranch || w.fromOrigin {
				ref := "origin/" + cmp.Or(w.pl.branch, r.DefaultBranch, "main")
				if w.pl.newBranch {
					ref = "origin/" + strings.TrimPrefix(cmp.Or(w.baseOf(r.ID), r.DefaultBranch, "main"), "origin/")
				}
				out = append(out, pending(SetupStep{Kind: SetupStepFetch, ProjectID: r.ID, ProjectName: r.Name, Ref: ref}))
			}
			out = append(out, pending(SetupStep{Kind: SetupStepWorktree, ProjectID: r.ID, ProjectName: r.Name, Branch: w.pl.branch}))
		}
	}
	return append(out, pending(SetupStep{Kind: SetupStepStart}))
}

// waitSetup waits for thread id's setup stage to end, if one runs.
func (m *Manager) waitSetup(ctx context.Context, id string) error {
	return m.endSetup(ctx, id, false)
}

// stopSetup stops thread id's setup stage, if one runs, and waits for it to end.
func (m *Manager) stopSetup(ctx context.Context, id string) error {
	return m.endSetup(ctx, id, true)
}

func (m *Manager) endSetup(ctx context.Context, id string, stop bool) error {
	m.mu.Lock()
	rec, ok := m.recs[id]
	var j *setupJob
	if ok {
		j = rec.setup
	}
	m.mu.Unlock()
	if j == nil {
		return nil
	}
	if stop {
		j.cancel()
	}
	select {
	case <-j.done:
		return nil
	case <-ctx.Done():
		return ctx.Err()
	}
}
