package thread

import (
	"cmp"
	"context"
	"errors"
	"fmt"
	"strings"
	"time"

	"github.com/alexwaumann/code-foundry/internal/store/workspace"
)

// Moving a thread without a project into a project or a workspace (Move;
// docs/notes/move-no-project-1-daemon.md).
//
// A user starts a thread without a project (it runs in the home folder) to look into
// something, then wants to keep working on it in a project. Move places it exactly as
// Create would place a new thread there, through Create's own code (placeThread: the
// worktrees, the refusals, the branch naming), names it again from its conversation
// (one naming call gives the title and, for a new branch, the branch), and moves Claude
// with Claude Code's own set_cwd control request, which relocates the transcript: the
// daemon never moves or copies a transcript.
//
// Whether or not Claude runs is hidden from the user, so a move never needs it running:
//
//   - Running at its prompt: set_cwd once it has been there for cdSettle (RunIn's queue,
//     tryCd); the call waits for the answer.
//   - Running mid-turn: the same queue; the call returns at once with PendingMove and
//     PendingWorktreePath set, and the move happens once the turn ends.
//   - Not running: Claude starts in the old cwd with --resume (no API call) and the
//     destination's --add-dir list, then set_cwd; the call waits. The process then stops
//     at its prompt cache expiry like any other, without the start's grace.
//   - Never had a conversation: nothing to relocate; the row changes at once.
//
// The row keeps its old place until Claude accepted set_cwd, then takes every field a
// Create there would have set (withMove). Any failure (a placement refusal, a start that
// fails, a refused set_cwd, Claude stopping before the move) leaves the thread without a
// project and removes the worktrees the move made (rollback); the timeline says what
// happened either way. A workspace's members reach a running Claude by the project-set
// restart (runner.dirsStale, maybeRestart), which resumes in the new cwd.

// errArchivedWhileMoving fails a move whose thread was archived before Claude moved
// (during the naming wait, or while it waited to start): an archived thread never starts.
var errArchivedWhileMoving = fmt.Errorf("%w: the thread was archived while moving", ErrFailedPrecondition)

// moveWait bounds how long Move waits for a thread that is not mid-turn to move; past
// it the call returns the thread with the move still queued.
const moveWait = 45 * time.Second

// moveJob is a placed move waiting for Claude's set_cwd (cdRequest.move). Once queued
// on a runner, started, restart and retried are the run goroutine's.
type moveJob struct {
	placed placedThread
	// title is the name the conversation gave; "" keeps the name.
	title string
	// place names where it goes, for the notes ("code-foundry", "workspace platform").
	place string
	// started: the process was started for this move (with the destination's
	// --add-dir list); false: it was running already and restarts for the list when the
	// destination has more folders (restart).
	started, restart bool
	// retried: Claude asked for the folder's trust once and was restarted to read it
	// (streamCd); a second needs_trust fails the move.
	retried bool
	// done receives the outcome once: nil when Claude moved, else why not.
	done chan error
}

// target is the move as Thread.PendingMove shows it.
func (j *moveJob) target() *MoveTarget {
	branch := ""
	if j.placed.createdWorktree {
		branch = j.placed.branch
	}
	return &MoveTarget{ProjectID: j.placed.projectID, WorkspaceID: j.placed.workspaceID, Path: j.placed.path, Branch: branch}
}

// withMove is s placed by j, as a Create with j's placement would have made it, and
// named by its title when it has one. Pure.
func (s Thread) withMove(j *moveJob) Thread {
	p := j.placed
	s.ProjectID, s.WorkspaceID, s.WorktreePath = p.projectID, p.workspaceID, p.path
	s.ProjectIDs = CleanProjectIDs(p.projectID, p.projectIDs)
	s.CheckoutPaths = p.checkouts
	if s.ProjectID != "" {
		s = s.withCheckout(s.ProjectID, s.WorktreePath)
	}
	s.BaseRef, s.CreatedWorktree, s.Branch = p.baseRef, p.createdWorktree, p.branch
	s.LastHeads = nil
	if j.title != "" {
		s.Name, s.AutoNamed, s.NameProvisional = j.title, true, false
	}
	s.PendingMove, s.PendingWorktreePath = nil, ""
	return s
}

// CheckMove refuses a Move of s: a thread with a project or a workspace (moving those is
// not supported), an archived one, the resident thread, one whose transcript is gone,
// and one already moving. Pure; the fake (threadtest) uses it too.
func CheckMove(s Thread) error {
	switch {
	case len(s.Projects()) > 0 || s.WorkspaceID != "":
		return fmt.Errorf("%w: thread %s already has a project; only a thread without one can be moved", ErrFailedPrecondition, s.ID)
	case !s.ArchivedAt.IsZero():
		return fmt.Errorf("%w: thread %s is archived; unarchive it first", ErrFailedPrecondition, s.ID)
	case s.Kind == KindResident:
		return fmt.Errorf("%w: thread %s is the resident %s thread; it cannot be moved", ErrFailedPrecondition, s.ID, s.ResidentName)
	case s.TranscriptMissing:
		return fmt.Errorf("%w: thread %s cannot be moved: %s", ErrFailedPrecondition, s.ID, TranscriptMissingMessage)
	case s.PendingMove != nil:
		return fmt.Errorf("%w: thread %s is already moving", ErrFailedPrecondition, s.ID)
	}
	return nil
}

// Move implements Store.
func (m *Manager) Move(ctx context.Context, id string, o MoveOptions) (Thread, error) {
	o.ProjectID, o.WorkspaceID = strings.TrimSpace(o.ProjectID), strings.TrimSpace(o.WorkspaceID)
	if o.ProjectID == "" && o.WorkspaceID == "" && o.WorktreePath == "" {
		return Thread{}, fmt.Errorf("%w: a project or a workspace to move the thread to is required", ErrInvalidArgument)
	}
	if o.NewWorktree != nil && o.CheckoutMode {
		return Thread{}, fmt.Errorf("%w: a new worktree and the project's folder exclude each other", ErrInvalidArgument)
	}
	if o.NewWorktree == nil && !o.CheckoutMode && o.WorktreePath == "" {
		// The user's worktree setting decides, as the composer's default does.
		if m.opts.NewWorktreeDefault() {
			o.NewWorktree = &NewWorktree{}
		} else {
			o.CheckoutMode = true
		}
	}
	cur, err := m.Get(ctx, id)
	if err != nil {
		return Thread{}, err
	}
	if err := CheckMove(cur); err != nil {
		return Thread{}, err
	}
	if cur.State == StateDisconnected && m.transcriptGone(cur) {
		// Refused before anything is made; a stopped thread says so from now on.
		m.setTranscriptMissing(id, cur.ClaudeSessionID, true)
		return Thread{}, ErrTranscriptMissing
	}
	want, place, err := m.moveTarget(o)
	if err != nil {
		return Thread{}, err
	}
	if err := m.claimMove(id, want); err != nil {
		return Thread{}, err
	}
	job, err := m.placeMove(ctx, id, o, place)
	if err != nil {
		m.releaseMove(id)
		return Thread{}, err
	}
	m.log.Info("moving thread", "thread", id, "to", place, "cwd", job.placed.path, "branch", job.placed.branch,
		"made", len(job.placed.made), "title", job.title)
	if o.Report != nil {
		*o.Report = CreateReport{MadeWorktree: job.placed.madePrimary, MadeBranch: job.placed.madeBranch, ExistingWorktree: job.placed.reusedPrimary}
		if o.Report.ExistingWorktree {
			if other, ok := m.otherHolder(id, job.placed.path); ok {
				o.Report.SharedWith = holderLabel(other)
			}
		}
	}
	// The move goes on once it started, whether or not the caller still waits: runMove's
	// waits are bounded (a start's handshake, a close), and a cancel there would fail a
	// move whose Claude is already starting.
	wait, err := m.runMove(context.WithoutCancel(ctx), id, job)
	if err != nil {
		m.failMove(ctx, id, job, err, false)
		return Thread{}, err
	}
	if wait {
		t := time.NewTimer(moveWait)
		defer t.Stop()
		select {
		case err := <-job.done:
			if err != nil {
				return Thread{}, err
			}
		case <-t.C:
			m.log.Info("thread move still queued; returning", "thread", id, "waited", moveWait.String())
		case <-ctx.Done():
			// The move goes on; the caller stopped waiting.
		}
	}
	return m.Get(ctx, id)
}

// moveTarget resolves o's project or workspace for PendingMove, and names it for the
// notes.
func (m *Manager) moveTarget(o MoveOptions) (MoveTarget, string, error) {
	if o.WorkspaceID != "" {
		w, err := m.resolveWorkspace(o.WorkspaceID)
		if err != nil {
			return MoveTarget{}, "", err
		}
		return MoveTarget{WorkspaceID: w.ID}, "workspace " + cmp.Or(w.Name, w.ID), nil
	}
	if m.opts.Projects == nil {
		return MoveTarget{ProjectID: o.ProjectID}, o.ProjectID, nil
	}
	if o.ProjectID == "" {
		pid, _, err := m.resolveWorktree("", o.WorktreePath)
		if err != nil {
			return MoveTarget{}, "", err
		}
		o.ProjectID = pid
	}
	r, err := m.projectByRef(m.opts.Projects.Snapshot(), o.ProjectID)
	if err != nil {
		return MoveTarget{}, "", err
	}
	return MoveTarget{ProjectID: r.ID}, cmp.Or(r.Name, r.ID), nil
}

// claimMove marks thread id as moving to want (PendingMove), refusing one that is
// closing, starting, or moving already, or that got a project meanwhile.
func (m *Manager) claimMove(id string, want MoveTarget) error {
	m.mu.Lock()
	defer m.mu.Unlock()
	rec, err := m.record(id)
	switch {
	case err != nil:
		return err
	case m.closed:
		return ErrClosed
	case rec.moving:
		return fmt.Errorf("%w: thread %s is already moving", ErrFailedPrecondition, id)
	case rec.s.State == StateClosing:
		return fmt.Errorf("%w: thread %s is stopping; try again in a moment", ErrFailedPrecondition, id)
	case rec.reserved != nil:
		return fmt.Errorf("%w: thread %s is starting; try again in a moment", ErrFailedPrecondition, id)
	}
	if err := CheckMove(rec.s); err != nil {
		return err
	}
	rec.moving = true
	rec.s.PendingMove = &want
	m.commitLocked(rec, false)
	return nil
}

// releaseMove ends a move that did not happen: the thread is as it was.
func (m *Manager) releaseMove(id string) {
	m.update(id, false, func(rec *record) {
		rec.moving, rec.lateMoveName = false, ""
		rec.s.PendingMove, rec.s.PendingWorktreePath, rec.s.Naming = nil, "", false
	})
}

// landMove gives rec the placement job made, and the name that arrived late while it was
// queued (applyLateMoveName). Callers hold m.mu.
func landMove(rec *record, job *moveJob) {
	rec.s = rec.s.withMove(job)
	named := job.title != ""
	if t := rec.lateMoveName; t != "" && !named {
		rec.s.Name, rec.s.AutoNamed, rec.s.NameProvisional = t, true, false
		named = true
	}
	rec.moving, rec.lateMoveName = false, ""
	rec.namingTried = rec.namingTried || named // a first-prompt namer not started yet never will
}

// placeMove names the thread from its conversation and places it with Create's code
// (placeThread), making what the placement needs; nothing is applied to the row.
func (m *Manager) placeMove(ctx context.Context, id string, o MoveOptions, place string) (*moveJob, error) {
	conv := ""
	if snap, err := m.Items(ctx, id); err != nil {
		m.log.Warn("read the conversation to name a moved thread", "thread", id, "err", err)
	} else {
		conv = recentTurnsContext(snap.Items)
	}
	co := CreateOptions{ProjectID: o.ProjectID, WorktreePath: o.WorktreePath, WorkspaceID: o.WorkspaceID,
		NewWorktree: o.NewWorktree, CheckoutMode: o.CheckoutMode && o.NewWorktree == nil}
	var named *slugWait
	co.naming = func(ctx context.Context, bc branchChoice) (slugWait, error) {
		sw := m.moveNaming(ctx, id, conv, &bc)
		named = &sw
		return sw, nil
	}
	if o.WorkspaceID != "" && strings.EqualFold(o.ProjectID, workspace.PrimaryWorkspace) {
		co.ProjectID = workspace.PrimaryWorkspace
	}
	p, err := m.placeThread(ctx, id, "", "", co)
	if err != nil {
		return nil, err
	}
	if named == nil {
		// No new branch to name: the title alone.
		sw := m.moveNaming(ctx, id, conv, nil)
		named = &sw
	}
	job := &moveJob{placed: p, title: named.name, place: place, done: make(chan error, 1)}
	if named.late != nil {
		m.applyLateMoveName(id, named.late)
	}
	if !m.opts.DisablePreTrust {
		// Claude trusts the destination before it gets there (set_cwd trusts the cwd
		// again); the worktrees placement made are trusted already.
		m.preTrustCheckouts(Thread{ID: id}.withMove(job))
	}
	m.update(id, false, func(rec *record) { rec.s.PendingMove = job.target() })
	return job, nil
}

// moveNaming asks the utility model for the thread's title from its conversation and,
// with bc, the new branch's name in the projects.branch_naming mode, waiting at most
// Options.SlugTimeout (as a new worktree's naming does). It is an explicit naming call
// (threads.auto_name does not turn it off) and it never fails the move: without a
// conversation, or when the model fails or is late, the branch falls back (composeBranch,
// pickBranch's cf/<thread id>) and the name stays. A late title is applied once the
// thread moved (applyLateMoveName). Thread.Naming is on meanwhile.
func (m *Manager) moveNaming(ctx context.Context, id, conv string, bc *branchChoice) slugWait {
	var sw slugWait
	var req NamingRequest
	if bc != nil {
		sw.branch = composeBranch(bc.cfg, bc.hint, "", "")
		req.Branch = bc.branchRequest()
	}
	if conv == "" {
		return sw // nothing to name from: the fallbacks
	}
	req.Conversation = conv
	if !m.track() {
		return sw
	}
	m.update(id, false, func(rec *record) { rec.s.Naming = true })
	defer m.update(id, false, func(rec *record) { rec.s.Naming = false })
	ch := make(chan namingResult, 1)
	go func() {
		defer m.wg.Done()
		n, err := m.regenerateCall(context.WithoutCancel(ctx), id, req)
		ch <- namingResult{Naming: n, err: err}
	}()
	start := time.Now()
	timer := time.NewTimer(m.opts.SlugTimeout)
	defer timer.Stop()
	select {
	case res := <-ch:
		if res.err != nil {
			m.log.Warn("naming a moved thread failed; keeping its name", "thread", id, "err", res.err)
			return sw
		}
		if bc != nil {
			sw.branch = composeBranch(bc.cfg, bc.hint, res.Branch, res.Title)
		}
		sw.namerCalled = true
		if title, err := cleanName(res.Title, false); err == nil {
			sw.name = title
		}
		m.log.Info("moved thread named", "thread", id, "name", sw.name, "branch", res.Branch,
			"took", time.Since(start).Round(time.Millisecond).String())
	case <-timer.C:
		m.log.Info("naming a moved thread timed out; using the fallbacks", "thread", id, "timeout", m.opts.SlugTimeout.String())
		sw.namerCalled, sw.late = true, ch
	case <-ctx.Done():
	}
	return sw
}

// track adds one to m.wg for a goroutine about to start, unless Shutdown began (false).
func (m *Manager) track() bool {
	m.mu.Lock()
	defer m.mu.Unlock()
	if m.closed {
		return false
	}
	m.wg.Add(1)
	return true
}

// applyLateMoveName names a moved thread from a title that missed SlugTimeout: at once
// when the thread has moved, when the move lands if it is still queued (landMove); a
// move that failed keeps the name.
func (m *Manager) applyLateMoveName(id string, ch <-chan namingResult) {
	if !m.track() {
		return
	}
	go func() {
		defer m.wg.Done()
		var res namingResult
		select {
		case res = <-ch:
		case <-m.ctx.Done():
			return
		}
		if res.err != nil {
			return
		}
		title, err := cleanName(res.Title, false)
		if err != nil {
			return
		}
		m.update(id, true, func(rec *record) {
			switch {
			case rec.moving:
				rec.lateMoveName = title
				m.log.Info("moved thread named; the name waits for the move", "thread", id, "name", title)
			case len(rec.s.Projects())+len(rec.s.WorkspaceID) > 0:
				rec.s.Name, rec.s.AutoNamed, rec.s.NameProvisional = title, true, false
				m.log.Info("moved thread named after it moved", "thread", id, "name", title)
			}
		})
	}()
}

// runMove hands job to the thread's Claude, starting it when it is not running, and
// reports whether Move should wait for the outcome (false: mid-turn, it moves once
// idle). A thread that never had a conversation moves at once. An error: the move did
// not start (failMove follows).
func (m *Manager) runMove(ctx context.Context, id string, job *moveJob) (bool, error) {
	for {
		live, closing, reserved, s, err := m.lifecycle(id)
		switch {
		case err != nil:
			return false, err
		case !s.ArchivedAt.IsZero():
			return false, errArchivedWhileMoving
		case live != nil:
			select {
			case <-live.ready:
			case <-live.done:
				continue // it ended before answering: start again
			case <-ctx.Done():
				return false, ctx.Err()
			}
			busy := s.Status == StatusBusy || s.PendingRequestID != "" || s.WakePending
			if !job.started {
				dest := s.withMove(job)
				job.restart = len(dest.Projects()) > 1 || dest.WorkspaceID != ""
			}
			wait := job.started || !busy // read before the runner owns job (streamCd may set started)
			if !m.queueMove(id, live, job) {
				continue // the runner changed meanwhile
			}
			return wait, nil
		case closing != nil:
			if err := waitDone(ctx, closing); err != nil {
				return false, err
			}
		case reserved != nil:
			select {
			case <-reserved:
			case <-ctx.Done():
				return false, ctx.Err()
			}
		case job.started:
			return false, fmt.Errorf("%w: Claude did not start to move the thread: %s", ErrFailedPrecondition, nonEmpty(s.LastError, "it ended before answering"))
		case !s.needsTranscript():
			// No conversation yet: nothing for Claude to relocate.
			if moved, err := m.moveStopped(ctx, id, job); err != nil || moved {
				return false, err
			}
			// started meanwhile: queue it on that process
		default:
			job.started = true
			_, err := m.startStopped(ctx, id, startOpts{move: job})
			switch {
			case errors.Is(err, errNotStopped):
				job.started = false // started meanwhile: queue it on that process
			case errors.Is(err, errArchivedWhileMoving):
				job.started = false
				return false, err
			case err != nil:
				job.started = false
				return false, fmt.Errorf("start Claude to move the thread: %w", err)
			default:
				m.log.Info("started thread to move it", "thread", id)
			}
		}
	}
}

// queueMove queues job on the live runner r (latest wins, as RunIn's); false when r is
// no longer the thread's runner.
func (m *Manager) queueMove(id string, r *runner, job *moveJob) bool {
	m.mu.Lock()
	defer m.mu.Unlock()
	rec, err := m.record(id)
	if err != nil || rec.run != r {
		return false
	}
	rec.s.PendingWorktreePath = job.placed.path
	select {
	case <-r.cdReq:
	default:
	}
	r.cdReq <- cdRequest{path: job.placed.path, projectID: job.placed.projectID, move: job}
	m.commitLocked(rec, false)
	m.log.Info("thread move queued until idle", "thread", id, "path", job.placed.path)
	return true
}

// moveStopped moves a stopped thread without a conversation: its row, at once. false
// without an error: it is starting or running now (a send since runMove looked), so the
// move goes to that process instead; the row never says a project while Claude runs in
// the old cwd.
func (m *Manager) moveStopped(ctx context.Context, id string, job *moveJob) (bool, error) {
	m.mu.Lock()
	rec, err := m.record(id)
	switch {
	case err != nil:
		m.mu.Unlock()
		return false, err
	case !rec.s.ArchivedAt.IsZero():
		m.mu.Unlock()
		return false, errArchivedWhileMoving
	case rec.run != nil || rec.reserved != nil:
		m.mu.Unlock()
		return false, nil
	}
	landMove(rec, job)
	m.commitLocked(rec, true)
	m.mu.Unlock()
	m.log.Info("thread moved", "thread", id, "to", job.place, "cwd", job.placed.path)
	m.noteMembers(ctx, id, movedNote(job), "")
	m.movedHooks(id, job)
	job.done <- nil
	return true, nil
}

// onMoved applies a move Claude accepted (streamCd): the row takes the placement, a
// running process that needs the destination's other folders restarts for them once
// quiet, and one started for the move has no start grace (it stops at its cache
// expiry). Run goroutine.
func (r *runner) onMoved(job *moveJob, relocated bool) {
	r.m.update(r.id, true, func(rec *record) {
		landMove(rec, job)
		if job.restart && !job.started && rec.run == r { // a process started (or restarted) for the move has them
			rec.run.dirsStale.Store(true) // the members as --add-dir (maybeRestart)
		}
	})
	if job.started {
		r.startedAt = time.Time{}
	}
	r.st.proj.w.add(Item{ID: r.st.proj.nextID("note"), Kind: KindNote, Text: movedNote(job)})
	r.log().info("thread moved", "to", job.place, "path", job.placed.path, "transcript_relocated", relocated)
	r.m.movedHooks(r.id, job)
	job.done <- nil
}

// onMoveFailed ends a move Claude refused (streamCd) or could not make (the checkout is
// gone): the thread stays where it is, the timeline says why, and the worktrees the
// move made go. A process started for the move stops (it has the destination's
// folders as --add-dir). Run goroutine.
func (r *runner) onMoveFailed(job *moveJob, why string) {
	err := fmt.Errorf("%w: Claude did not move to %s: %s", ErrFailedPrecondition, job.placed.path, why)
	r.st.proj.w.add(Item{ID: r.st.proj.nextID("note"), Kind: KindNote, Text: moveFailedNote(job, why)})
	if job.started && !r.closing {
		r.disconnectAs = ReasonIdle
		r.beginClose()
	}
	r.m.wg.Add(1)
	go func() {
		defer r.m.wg.Done()
		r.m.failMove(context.Background(), r.id, job, err, true)
	}()
}

// failMove ends a move that did not happen: the worktrees it made are removed, the
// thread is as it was, and (unless noted already) the timeline says why. done gets err.
func (m *Manager) failMove(ctx context.Context, id string, job *moveJob, err error, noted bool) {
	m.log.Warn("thread move failed; it stays without a project", "thread", id, "to", job.place, "err", err)
	ctx = context.WithoutCancel(ctx) // the caller may have stopped waiting; the cleanup still runs
	m.stopMoveStart(id, job)
	m.rollback(ctx, job.placed.made)
	m.releaseMove(id)
	m.update(id, false, func(rec *record) { rec.s.LastError = "move to " + job.place + ": " + err.Error() })
	if !noted {
		// The error's class is for callers, not the timeline.
		why := strings.ReplaceAll(err.Error(), ErrFailedPrecondition.Error()+": ", "")
		m.noteMembers(ctx, id, moveFailedNote(job, why), "")
	}
	select {
	case job.done <- err:
	default:
	}
}

// stopMoveStart stops the process started for job when it still runs: it has the
// destination's folders as --add-dir, and nobody asked for it (closed as at its cache
// expiry). A process started otherwise (a send) is left alone.
func (m *Manager) stopMoveStart(id string, job *moveJob) {
	m.mu.Lock()
	var r *runner
	if rec, err := m.record(id); err == nil {
		r = rec.run
	}
	m.mu.Unlock()
	if r != nil && r.startedFor == job {
		r.requestCloseAs(ReasonIdle)
	}
}

// movedHooks runs the projects' on-worktree-create actions for the worktrees a move
// made, as Create does once its thread started.
func (m *Manager) movedHooks(id string, job *moveJob) {
	if m.opts.WorktreeCreated == nil {
		return
	}
	for _, w := range job.placed.made {
		m.opts.WorktreeCreated(id, w.projectID, w.path)
	}
}

// movedNote is the timeline's line once a thread moved: where, and in what checkout.
func movedNote(job *moveJob) string {
	return "Moved this thread to " + job.place + " (" + moveWhere(job) + ")."
}

// moveFailedNote is the timeline's line for a move that did not happen.
func moveFailedNote(job *moveJob, why string) string {
	return "Could not move this thread to " + job.place + ": " + why + ". It stays where it was, without a project."
}

// moveWhere says what checkout a move put the thread in.
func moveWhere(job *moveJob) string {
	p := job.placed
	switch {
	case p.madePrimary && p.madeBranch:
		return "new worktree on " + p.branch
	case p.madePrimary:
		return "new worktree on existing branch " + p.branch
	case p.reusedPrimary:
		return "worktree " + p.path + " on " + p.branch
	case p.createdWorktree:
		return p.path + ", worktrees on " + p.branch
	default:
		return p.path
	}
}
