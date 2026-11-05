package thread

import (
	"cmp"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"slices"
	"strings"
	"time"

	"github.com/alexwaumann/code-foundry/internal/store/project"
)

// A thread's setup (docs/notes/instant-threads-1-daemon.md). Create has two stages: a
// fast one that refuses what needs no slow work and otherwise puts the thread and its
// first message on the record, and a setup stage (setup_run.go) that names the branch,
// fetches, makes the worktrees and starts Claude. Thread.Setup is the record of the
// second: every step is listed, pending, from the start, changes as it happens, and stays
// after a success, so the timeline can say how long it took after a reload.
//
// While a setup runs the thread is STARTING with a reservation (lifecycle.go), so whatever
// waits on a start waits on it, and BUSY "setting up", so it reads as working everywhere a
// starting thread does. It has no process and, in worktree mode, no checkouts (unplaced).
// spawn's commit ends it: the process, the reservation and the phase change together. A
// failure leaves the thread DISCONNECTED and ERROR ReasonSetupFailed, which settles a
// wait; it cannot start again by itself, since nothing says its checkouts exist. A cancel
// leaves it DISCONNECTED and IDLE ReasonSetupCancelled: the user did that, so it wants
// nothing of them. setup_actions.go is the way out of either.

// ReasonSettingUp is the StatusReason, with StatusBusy, of a thread whose setup runs.
const ReasonSettingUp = "setting up"

// ReasonSetupFailed is the StatusReason, with StatusError, and the DisconnectReason of a
// thread whose setup failed; Setup.Error and LastError say why.
const ReasonSetupFailed = "setup failed"

// ReasonSetupCancelled is the StatusReason, with StatusIdle, and the DisconnectReason of a
// thread whose setup the user cancelled.
const ReasonSetupCancelled = "setup cancelled"

// SetupRestarted is Setup.Error of a thread the daemon lost during its setup.
const SetupRestarted = "Code Foundry restarted during setup"

// MaxDraftJSON bounds CreateOptions.DraftJSON, in bytes.
const MaxDraftJSON = 1 << 20

// SetupPhase is where a setup stands. Values mirror codefoundry.v1.ThreadSetupPhase.
type SetupPhase int

// Setup phases.
const (
	SetupUnspecified SetupPhase = iota
	SetupRunning
	SetupDone
	SetupFailed
	SetupCancelled
)

// SetupStepKind is what a step does. Values mirror codefoundry.v1.ThreadSetupStepKind.
type SetupStepKind int

// Setup step kinds.
const (
	SetupStepUnspecified SetupStepKind = iota
	SetupStepName
	SetupStepFetch
	SetupStepWorktree
	SetupStepStart
)

// SetupStepStatus is how a step stands. Values mirror
// codefoundry.v1.ThreadSetupStepStatus.
type SetupStepStatus int

// Setup step statuses.
const (
	SetupStepStatusUnspecified SetupStepStatus = iota
	SetupStepPending
	SetupStepRunning
	SetupStepDone
	SetupStepWarning
	SetupStepFailed
)

// SetupStep is one step of a Setup: a value inside it, replaced with it.
type SetupStep struct {
	Kind SetupStepKind `json:"kind"`
	// ProjectID and ProjectName are a fetch's or worktree's project; "" for name and
	// start.
	ProjectID   string `json:"project_id,omitempty"`
	ProjectName string `json:"project_name,omitempty"`
	// Ref is what a fetch fetches ("origin/main"), a worktree's start point once made.
	Ref string `json:"ref,omitempty"`
	// Branch is the branch of a name or worktree step, once named.
	Branch string `json:"branch,omitempty"`
	// Existing, on a name step: the branch was there to check out, so its base is ignored.
	Existing  bool            `json:"existing,omitempty"`
	Status    SetupStepStatus `json:"status"`
	StartedAt time.Time       `json:"started_at,omitzero"`
	EndedAt   time.Time       `json:"ended_at,omitzero"`
	// Error is git's text, of a failed step and of a fetch's warning.
	Error string `json:"error,omitempty"`
	// Warning is what went wrong in a line, with SetupStepWarning.
	Warning string `json:"warning,omitempty"`
	// RefAt, with a fetch's warning, is the commit time of Ref's tip on disk, which the
	// branch starts from instead; zero when there is no such ref.
	RefAt time.Time `json:"ref_at,omitzero"`
}

// SetupWorktree is a worktree a setup made, with what it takes to remove it again.
type SetupWorktree struct {
	ProjectID string `json:"project_id"`
	Path      string `json:"path"`
	Branch    string `json:"branch"`
	NewBranch bool   `json:"new_branch,omitempty"`
	// OwnBranch: the local branch did not exist. NewBranch says the same of the remote
	// too; a local branch made from origin's is the setup's as well.
	OwnBranch  bool   `json:"own_branch,omitempty"`
	StartPoint string `json:"start_point,omitempty"`
}

// SetupAdd is a `git worktree add` running now: what project.AbandonWorktree takes,
// should the daemon die during it, when nothing is there to clean up after it. Head is
// where the add starts the branch it makes; "" when the branch exists.
type SetupAdd struct {
	ProjectID string `json:"project_id"`
	Path      string `json:"path"`
	Branch    string `json:"branch,omitempty"`
	Head      string `json:"head,omitempty"`
}

// SetupRequest is what a setup needs to run again that is not on the row: CreateOptions'
// placement and first message, as given. The thread's Model, Effort, PermissionMode,
// CreatedBy, Brief, Labels, BudgetUSD, Owner, SpawnEnv, SpawnAddDirs and SystemPromptAppend
// are its own fields.
type SetupRequest struct {
	ProjectID      string       `json:"project_id,omitempty"`
	WorktreePath   string       `json:"worktree_path,omitempty"`
	ProjectIDs     []string     `json:"project_ids,omitempty"`
	Like           string       `json:"like,omitempty"`
	NewBranch      bool         `json:"new_branch,omitempty"`
	CheckoutMode   bool         `json:"checkout_mode,omitempty"`
	WorkspaceID    string       `json:"workspace_id,omitempty"`
	NoProject      bool         `json:"no_project,omitempty"`
	Cwd            string       `json:"cwd,omitempty"`
	ResumeSession  string       `json:"resume_session,omitempty"`
	NewWorktree    *NewWorktree `json:"new_worktree,omitempty"`
	Name           string       `json:"name,omitempty"`
	InitialPrompt  string       `json:"initial_prompt,omitempty"`
	ComposerPrompt string       `json:"composer_prompt,omitempty"`
	Attachments    []string     `json:"attachments,omitempty"`
	Notify         bool         `json:"notify,omitempty"`
	// DraftJSON is CreateOptions.DraftJSON: the GUI's, never read here.
	DraftJSON string `json:"draft_json,omitempty"`
}

// setupRequestOf is what o's setup would need to run again.
func setupRequestOf(o CreateOptions) *SetupRequest {
	return &SetupRequest{ProjectID: o.ProjectID, WorktreePath: o.WorktreePath, ProjectIDs: slices.Clone(o.ProjectIDs), Like: o.Like,
		NewBranch: o.NewBranch, CheckoutMode: o.CheckoutMode, WorkspaceID: o.WorkspaceID, NoProject: o.NoProject, Cwd: o.Cwd,
		ResumeSession: o.ResumeSession, NewWorktree: o.NewWorktree, Name: o.Name, InitialPrompt: o.InitialPrompt,
		ComposerPrompt: o.ComposerPrompt, Attachments: slices.Clone(o.Attachments), Notify: o.Notify, DraftJSON: o.DraftJSON}
}

// Setup is Thread.Setup. Never changed in place: edit makes the copy that replaces it.
type Setup struct {
	Phase     SetupPhase  `json:"phase"`
	StartedAt time.Time   `json:"started_at,omitzero"`
	EndedAt   time.Time   `json:"ended_at,omitzero"`
	Steps     []SetupStep `json:"steps"`
	// Error is why it failed, in full.
	Error string `json:"error,omitempty"`
	// Background: the caller of Create did not wait for it. One that waits hears of a
	// failure itself, so nothing of it may stay behind.
	Background bool `json:"background,omitempty"`
	// Made are the worktrees it made so far, Adding the adds that have not ended, Held the worktrees of others it is about to work in (no checkout says so before the
	// placement lands), and Request what it needs to run again. Not on the API; dropped
	// with a success.
	Made    []SetupWorktree `json:"made,omitempty"`
	Adding  []SetupAdd      `json:"adding,omitempty"`
	Held    []string        `json:"held,omitempty"`
	Request *SetupRequest   `json:"request,omitempty"`
	// Queued are the messages sent during the setup, in order, each until Claude has it:
	// like PendingFirst it outlives a success, and goes at the next start after a daemon
	// death. Prompt is as built, its references rewritten by the spawn that delivers it.
	Queued []PendingFirst `json:"queued,omitempty"`
}

// edit is s changed by fn, s untouched.
func (s *Setup) edit(fn func(*Setup)) *Setup {
	c := *s
	c.Steps, c.Made, c.Adding = slices.Clone(s.Steps), slices.Clone(s.Made), slices.Clone(s.Adding)
	c.Held, c.Queued = slices.Clone(s.Held), slices.Clone(s.Queued)
	fn(&c)
	return &c
}

// step is the step of kind for project id; nil when there is none.
func (s *Setup) step(kind SetupStepKind, projectID string) *SetupStep {
	i := slices.IndexFunc(s.Steps, func(st SetupStep) bool { return st.Kind == kind && st.ProjectID == projectID })
	if i < 0 {
		return nil
	}
	return &s.Steps[i]
}

// begin marks a step that has not started as running.
func (st *SetupStep) begin(now time.Time) {
	if st != nil && st.Status == SetupStepPending {
		st.Status, st.StartedAt = SetupStepRunning, now
	}
}

// end marks a step finished with status; one that never showed as running took no time.
func (st *SetupStep) end(status SetupStepStatus, now time.Time) {
	if st == nil {
		return
	}
	if st.StartedAt.IsZero() {
		st.StartedAt = now
	}
	st.Status, st.EndedAt = status, now
}

// reset makes st pending again, keeping what says what it is for.
func (st *SetupStep) reset() {
	*st = SetupStep{Kind: st.Kind, ProjectID: st.ProjectID, ProjectName: st.ProjectName, Ref: st.Ref, Branch: st.Branch, Status: SetupStepPending}
}

// drop removes the steps match says have nothing to do.
func (s *Setup) drop(match func(SetupStep) bool) {
	s.Steps = slices.DeleteFunc(s.Steps, match)
}

// done is s succeeded: spawn's commit. What a retry would need goes.
func (s *Setup) done(now time.Time) *Setup {
	return s.edit(func(c *Setup) {
		c.step(SetupStepStart, "").end(SetupStepDone, now)
		c.Phase, c.EndedAt, c.Made, c.Adding, c.Held, c.Request = SetupDone, now, nil, nil, nil, nil
	})
}

// cancelled is s stopped by the user, what it made gone: what was under way never happened.
func (s *Setup) cancelled(now time.Time) *Setup {
	return s.edit(func(c *Setup) {
		c.Phase, c.EndedAt, c.Error = SetupCancelled, now, ""
		c.Made, c.Adding, c.Held = nil, nil, nil
		for i := range c.Steps {
			if st := &c.Steps[i]; st.Status == SetupStepRunning || st.Status == SetupStepFailed {
				st.reset()
			}
		}
	})
}

// retried is s running again from now. After a failure the steps that ended well stay,
// so it goes on at the one that failed. After a cancel nothing is left of them.
func (s *Setup) retried(now time.Time) *Setup {
	fromStart := s.Phase == SetupCancelled
	return s.edit(func(c *Setup) {
		c.Phase, c.StartedAt, c.EndedAt, c.Error, c.Background = SetupRunning, now, time.Time{}, "", true
		for i := range c.Steps {
			if st := &c.Steps[i]; fromStart || st.Status == SetupStepFailed || st.Status == SetupStepRunning {
				st.reset()
			}
		}
	})
}

// failed is s ended by why: each step still running fails with it, and when none has
// failed yet (a refusal before any step began) the first pending one takes it, so the
// list shows where it stopped.
func (s *Setup) failed(now time.Time, why string) *Setup {
	return s.edit(func(c *Setup) {
		c.Phase, c.EndedAt, c.Error = SetupFailed, now, why
		for i := range c.Steps {
			if st := &c.Steps[i]; st.Status == SetupStepRunning {
				st.Error = why
				st.end(SetupStepFailed, now)
			}
		}
		if slices.ContainsFunc(c.Steps, func(st SetupStep) bool { return st.Status == SetupStepFailed }) {
			return
		}
		if i := slices.IndexFunc(c.Steps, func(st SetupStep) bool { return st.Status == SetupStepPending }); i >= 0 {
			c.Steps[i].Error = why
			c.Steps[i].end(SetupStepFailed, now)
		}
	})
}

// setupJSON is the setup column: "" for none.
func setupJSON(s *Setup) string {
	if s == nil {
		return ""
	}
	b, err := json.Marshal(s)
	if err != nil {
		return "" // plain strings, numbers and times: never happens
	}
	return string(b)
}

// parseSetup reads the setup column; empty or malformed is none.
func parseSetup(col string) *Setup {
	if col == "" {
		return nil
	}
	var s Setup
	if json.Unmarshal([]byte(col), &s) != nil {
		return nil
	}
	return &s
}

// SettingUp reports whether t's setup is running.
func (t Thread) SettingUp() bool { return t.Setup != nil && t.Setup.Phase == SetupRunning }

// setupUnfinished reports whether t was created and never started: its setup runs, or
// ended without Claude.
func (t Thread) setupUnfinished() bool { return t.Setup != nil && t.Setup.Phase != SetupDone }

// unplaced reports whether t has no cwd and no checkouts yet: its worktrees are being
// made, or a setup that failed never got that far. A cwd says the placement landed.
func (t Thread) unplaced() bool { return t.setupUnfinished() && t.WorktreePath == "" }

// setupStopped reports whether t's setup failed or was cancelled: the two it can be tried
// again from.
func (t Thread) setupStopped() bool {
	return t.Setup != nil && (t.Setup.Phase == SetupFailed || t.Setup.Phase == SetupCancelled)
}

// failSetup ends t's setup with why: no process, an error that sorts with the threads
// that want the user, and a settled wait.
func (t *Thread) failSetup(now time.Time, why string) {
	t.State, t.DisconnectReason, t.LastError = StateDisconnected, ReasonSetupFailed, why
	t.setStatus(StatusError, ReasonSetupFailed, now)
	t.Setup = t.Setup.failed(now, why)
}

// cancelSetup ends t's setup at the user's word: no process, a quiet status and a settled
// wait.
func (t *Thread) cancelSetup(now time.Time) {
	t.State, t.DisconnectReason, t.LastError = StateDisconnected, ReasonSetupCancelled, ""
	t.setStatus(StatusIdle, ReasonSetupCancelled, now)
	t.Setup = t.Setup.cancelled(now)
}

// unplace forgets a placement whose worktrees went with its setup: it is planned again.
func (t *Thread) unplace() {
	t.WorktreePath, t.CheckoutPaths, t.Branch, t.BaseRef, t.CreatedWorktree = "", nil, "", "", false
}

// setupWhy is err as a setup tells it: without the thread's own prefix and the error
// classes, which mean something to a caller, not to someone reading the timeline.
func setupWhy(id string, err error) string {
	why := strings.TrimPrefix(err.Error(), "thread "+id+": ")
	why = strings.ReplaceAll(why, ErrFailedPrecondition.Error()+": ", "")
	return strings.ReplaceAll(why, ErrInvalidArgument.Error()+": ", "")
}

// setupRefusal is the refusal of doing ("sent to", "forked") to a thread that needs
// Claude or its checkouts while it has neither; nil for any other thread.
func setupRefusal(t Thread, doing string) error {
	switch {
	case t.SettingUp():
		return fmt.Errorf("%w: thread %s is still being set up; it cannot be %s yet", ErrFailedPrecondition, t.ID, doing)
	case t.setupUnfinished():
		return fmt.Errorf("%w: thread %s did not finish its setup, so it cannot be %s: %s; try its setup again first",
			ErrFailedPrecondition, t.ID, doing, cmp.Or(t.Setup.Error, "it was cancelled"))
	}
	return nil
}

// refuseSetup is setupRefusal for thread id.
func (m *Manager) refuseSetup(id, doing string) error {
	t, ok := m.Snapshot().Thread(id)
	if !ok {
		return nil // the caller says what is missing
	}
	return setupRefusal(t, doing)
}

// refuseSettingUp refuses doing only while thread id's setup runs: on a thread whose setup
// failed it only goes to the row, as on any stopped thread.
func (m *Manager) refuseSettingUp(id, doing string) error {
	if t, ok := m.Snapshot().Thread(id); ok && t.SettingUp() {
		return setupRefusal(t, doing)
	}
	return nil
}

// setupTracker publishes one setup's steps as they change, through the normal commit. A
// nil tracker (a Move's placement) does nothing.
type setupTracker struct {
	m  *Manager
	id string
}

// keepMade reports whether a failure leaves the worktrees made so far: a setup has them on
// its record, and whoever ends it takes them from there.
func (t *setupTracker) keepMade() bool { return t != nil }

// edit changes the setup, persisted.
func (t *setupTracker) edit(fn func(s *Setup, now time.Time)) {
	if t == nil {
		return
	}
	now := t.m.opts.Now()
	t.m.update(t.id, true, func(r *record) {
		if r.s.Setup != nil {
			r.s.Setup = r.s.Setup.edit(func(s *Setup) { fn(s, now) })
		}
	})
}

// begin marks a step running.
func (t *setupTracker) begin(kind SetupStepKind, projectID string) {
	t.edit(func(s *Setup, now time.Time) { s.step(kind, projectID).begin(now) })
}

// titled names the thread with the namer's title the moment it is known, unless the user
// named it meanwhile, and records that the namer ran.
func (t *setupTracker) titled(title string, namerCalled bool) {
	if t == nil || (title == "" && !namerCalled) {
		return
	}
	t.m.update(t.id, true, func(r *record) {
		r.namingTried = r.namingTried || namerCalled
		if title != "" {
			r.s.applyNamerTitle(title)
		}
	})
}

// named ends the name step with branch, which every worktree step goes on. existing: it
// was there to check out.
func (t *setupTracker) named(branch string, existing bool) {
	t.edit(func(s *Setup, now time.Time) {
		s.name(branch, existing)
		s.step(SetupStepName, "").end(SetupStepDone, now)
	})
}

// renamed is named for a retry whose branch changed: the step ended with the run before.
func (t *setupTracker) renamed(branch string, existing bool) {
	t.edit(func(s *Setup, _ time.Time) { s.name(branch, existing) })
}

// name puts branch on the name step and every worktree step.
func (s *Setup) name(branch string, existing bool) {
	if st := s.step(SetupStepName, ""); st != nil {
		st.Branch, st.Existing = branch, existing
	}
	for i := range s.Steps {
		if s.Steps[i].Kind == SetupStepWorktree {
			s.Steps[i].Branch = branch
		}
	}
}

// progress is the project store's Progress for project id's steps.
func (t *setupTracker) progress(projectID string) func(project.WorktreeEvent) {
	if t == nil {
		return nil
	}
	return func(ev project.WorktreeEvent) {
		t.edit(func(s *Setup, now time.Time) {
			switch ev.Kind {
			case project.WorktreeFetchStarted:
				if st := s.step(SetupStepFetch, projectID); st != nil {
					st.Ref = ev.Ref
					st.begin(now)
				}
			case project.WorktreeFetchEnded:
				st := s.step(SetupStepFetch, projectID)
				if st == nil {
					return
				}
				if ev.Err == nil {
					st.end(SetupStepDone, now)
					return
				}
				if errors.Is(ev.Err, context.Canceled) {
					// It says nothing about the remote: the setup stopped it. It stays running,
					// with its time, until the setup says how it ended: a cancel puts it back
					// to pending, the next start after a daemon stop fails it with the reason.
					return
				}
				st.Warning, st.Error, st.RefAt = "Could not reach "+ev.Remote, project.GitText(ev.Err), ev.RefAt
				st.end(SetupStepWarning, now)
			case project.WorktreeAdding:
				s.step(SetupStepWorktree, projectID).begin(now)
				s.Adding = append(s.Adding, SetupAdd{ProjectID: projectID, Path: ev.Path, Branch: ev.Branch, Head: ev.Head})
			}
		})
	}
}

// fetched drops project id's fetch step when nothing was fetched after all (a tag, a sha,
// no origin, a local branch).
func (t *setupTracker) fetched(projectID string) {
	t.edit(func(s *Setup, _ time.Time) {
		s.drop(func(st SetupStep) bool {
			return st.Kind == SetupStepFetch && st.ProjectID == projectID && st.Status == SetupStepPending
		})
	})
}

// nothingToMake drops project id's steps: its worktree exists.
func (t *setupTracker) nothingToMake(projectID string) {
	t.edit(func(s *Setup, _ time.Time) {
		s.drop(func(st SetupStep) bool {
			return st.ProjectID == projectID && (st.Kind == SetupStepFetch || st.Kind == SetupStepWorktree)
		})
	})
}

// made ends w's worktree step and records it, so a failure later can be cleaned up.
func (t *setupTracker) made(w madeWorktree) {
	t.edit(func(s *Setup, now time.Time) {
		s.drop(func(st SetupStep) bool {
			return st.Kind == SetupStepFetch && st.ProjectID == w.projectID && st.Status == SetupStepPending
		})
		if st := s.step(SetupStepWorktree, w.projectID); st != nil {
			st.Ref, st.Branch = w.startPoint, w.branch
			st.end(SetupStepDone, now)
		}
		s.Made = append(s.Made, SetupWorktree{ProjectID: w.projectID, Path: w.path, Branch: w.branch, NewBranch: w.newBranch, OwnBranch: w.ownBranch, StartPoint: w.startPoint})
		s.Adding = slices.DeleteFunc(s.Adding, func(a SetupAdd) bool { return a.ProjectID == w.projectID })
	})
}

// holds records that the setup is about to work in a worktree it did not make.
func (t *setupTracker) holds(path string) {
	t.edit(func(s *Setup, _ time.Time) { s.Held = append(s.Held, path) })
}

// worktreeStopped ends project id's add when the setup was stopped, not git: its step
// stays as it is until the setup says how it ended, as a stopped fetch's does.
func (t *setupTracker) worktreeStopped(projectID string) {
	t.edit(func(s *Setup, _ time.Time) {
		s.Adding = slices.DeleteFunc(s.Adding, func(a SetupAdd) bool { return a.ProjectID == projectID })
	})
}

// worktreeFailed fails project id's worktree step with git's text. Its add is over: git
// or the project store cleaned up after it.
func (t *setupTracker) worktreeFailed(projectID string, err error) {
	t.edit(func(s *Setup, now time.Time) {
		if st := s.step(SetupStepWorktree, projectID); st != nil {
			st.Error = setupWhy(t.id, errors.New(project.GitText(err)))
			st.end(SetupStepFailed, now)
		}
		s.Adding = slices.DeleteFunc(s.Adding, func(a SetupAdd) bool { return a.ProjectID == projectID })
	})
}
