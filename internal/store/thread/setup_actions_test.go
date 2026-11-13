package thread

import (
	"bytes"
	"context"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"runtime"
	"slices"
	"strings"
	"sync/atomic"
	"syscall"
	"testing"
	"time"

	"github.com/alexwaumann/code-foundry/internal/bus"
	"github.com/alexwaumann/code-foundry/internal/store/project"
	"github.com/alexwaumann/code-foundry/internal/store/project/projecttest"
)

// flakyProjects fails one project's worktree while failing says so, as git would: after
// the fetch.
type flakyProjects struct {
	*recordingProjects
	failing atomic.Pointer[string]
}

func (p *flakyProjects) CreateWorktree(ctx context.Context, o project.CreateWorktreeOptions) (project.Worktree, error) {
	if f := p.failing.Load(); f != nil && *f == o.ProjectID {
		return project.Worktree{}, &project.GitError{Stderr: "fatal: other refuses\n", ExitCode: 128}
	}
	return p.recordingProjects.CreateWorktree(ctx, o)
}

func (p *flakyProjects) fail(id string) { p.failing.Store(&id) }
func (p *flakyProjects) heal()          { p.failing.Store(nil) }

// flakyEnv is an env with r1 and r2 whose worktrees can fail, and a counted namer.
func flakyEnv(t *testing.T, mutate ...func(*Options)) (*env, *flakyProjects, *atomic.Int32) {
	t.Helper()
	var flaky *flakyProjects
	e, _ := newWorktreeEnv(t, nil, append([]func(*Options){func(o *Options) {
		flaky = &flakyProjects{recordingProjects: o.Projects.(*recordingProjects)}
		o.Projects = flaky
	}}, mutate...)...)
	e.addGitProject(t, "r2", "other")
	var named atomic.Int32
	e.namer = func(string) (string, error) {
		named.Add(1)
		return "Title: Fix login\nBranch: fix/login", nil
	}
	return e, flaky, &named
}

// twoProjects is the options of a thread in r1 and r2 on a new branch.
func twoProjects() CreateOptions {
	return CreateOptions{ProjectIDs: []string{"r1", "r2"}, InitialPrompt: "do x", NewWorktree: &NewWorktree{}, BackgroundSetup: true}
}

// failedOnR2 is a background setup that made r1's worktree and failed on r2's.
func failedOnR2(t *testing.T, e *env, flaky *flakyProjects) Thread {
	t.Helper()
	flaky.fail("r2")
	s, err := e.m.Create(e.ctx(), twoProjects())
	if err != nil {
		t.Fatal(err)
	}
	return e.waitFor(s.ID, "the setup to fail", func(s Thread) bool { return s.Setup.Phase == SetupFailed })
}

func countCalls(calls []string, prefix string) int {
	n := 0
	for _, c := range calls {
		if strings.HasPrefix(c, prefix) {
			n++
		}
	}
	return n
}

func worktreeCount(rr *recordingProjects, id string) int {
	r, _ := rr.Snapshot().Project(id)
	return len(r.Worktrees)
}

// countTurnEnds counts the top-level turn ends of a thread's items.
func countTurnEnds(items []Item) int {
	n := 0
	for _, it := range items {
		if it.Kind == KindTurnEnd && it.ParentToolUseID == "" {
			n++
		}
	}
	return n
}

func TestRetryResumesAtTheFailedStep(t *testing.T) {
	e, flaky, named := flakyEnv(t)
	s := failedOnR2(t, e, flaky)
	if len(s.Setup.Made) != 1 || s.Setup.Made[0].ProjectID != "r1" {
		t.Fatalf("made %+v", s.Setup.Made)
	}
	branch := s.Setup.step(SetupStepName, "").Branch
	if branch == "" || stepStatus(s, SetupStepWorktree, "r2") != SetupStepFailed {
		t.Fatalf("steps %+v", s.Setup.Steps)
	}
	fetches := len(flaky.Fetches)
	failedAt := s.Setup.StartedAt
	flaky.heal()

	got, err := e.m.RetrySetup(e.ctx(), s.ID)
	if err != nil {
		t.Fatal(err)
	}
	if got.Status == StatusError || got.LastError != "" || got.DisconnectReason != "" {
		t.Errorf("retried: %v %q, last error %q, disconnect %q", got.Status, got.StatusReason, got.LastError, got.DisconnectReason)
	}
	done := e.waitFor(s.ID, "the retry to land", func(s Thread) bool { return s.Setup.Phase == SetupDone })
	if done.Branch != branch || done.WorktreePath == "" {
		t.Errorf("branch %q (was %q), cwd %q", done.Branch, branch, done.WorktreePath)
	}
	if n := named.Load(); n != 1 {
		t.Errorf("namer ran %d times", n)
	}
	// r1's worktree stayed, r2's was made: one call each, nothing fetched twice.
	r1, r2 := 0, 0
	for _, o := range flaky.created() {
		switch o.ProjectID {
		case "r1":
			r1++
		case "r2":
			r2++
		}
	}
	if r1 != 1 || r2 != 1 {
		t.Errorf("worktrees made: r1 %d, r2 %d", r1, r2)
	}
	if got := len(flaky.Fetches); got != fetches {
		t.Errorf("fetched again: %d, was %d", got, fetches)
	}
	if !done.Setup.StartedAt.After(failedAt) {
		t.Errorf("started at %v, the first run at %v", done.Setup.StartedAt, failedAt)
	}
	for _, st := range done.Setup.Steps {
		if st.Status != SetupStepDone {
			t.Errorf("step %+v", st)
		}
	}
	if done.Setup.Error != "" || done.Setup.Made != nil || done.Setup.Request != nil {
		t.Errorf("a finished retry keeps %+v", done.Setup)
	}
	// The worktree it kept is the thread's, in its checkouts.
	if p, ok := done.CheckoutPath("r1"); !ok || p == "" {
		t.Errorf("r1's checkout: %q %v", p, ok)
	}
	e.waitUserText("do x")
	if got := e.sentTexts(); len(got) != 1 {
		t.Errorf("sent %q", got)
	}
}

// The turn the failure closed reads as one turn after a retry: the message, the answer,
// one turn end. Until the answer there is no turn end for a wait to take for it.
func TestRetryReopensTheTurn(t *testing.T) {
	e, flaky, _ := flakyEnv(t)
	s := failedOnR2(t, e, flaky)
	if n := countTurnEnds(e.items(s.ID).Items); n != 1 {
		t.Fatalf("%d turn ends after the failure", n)
	}
	sub := bus.Subscribe[ThreadEvent](e.bus, 64)
	defer sub.Close()
	flaky.heal()
	release := holdSpawn(t, flaky)
	if _, err := e.m.RetrySetup(e.ctx(), s.ID); err != nil {
		t.Fatal(err)
	}
	if n := countTurnEnds(e.items(s.ID).Items); n != 0 {
		t.Errorf("a turn end stays for a wait to settle on:\n%s", describeItems(e.items(s.ID).Items))
	}
	if rows, err := loadItems(e.ctx(), e.m.opts.DB, s.ID); err != nil || countTurnEnds(rows) != 0 {
		t.Errorf("the row stays: %v", err)
	}
	// A client that watches is told to read again.
	waitBusFor(t, sub, func(ev ThreadEvent) bool { _, ok := ev.(ItemsReset); return ok && ev.Thread() == s.ID })
	release()
	items := e.waitItems(s.ID, "the answer", func(items []Item) bool { return countTurnEnds(items) == 1 })
	var kinds []ItemKind
	for _, it := range items {
		if it.Kind == KindUserMessage || it.Kind == KindAssistantText || it.Kind == KindTurnEnd {
			kinds = append(kinds, it.Kind)
		}
	}
	if !slices.Equal(kinds, []ItemKind{KindUserMessage, KindAssistantText, KindTurnEnd}) {
		t.Errorf("timeline:\n%s", describeItems(items))
	}
}

// holdSpawn holds r2's worktree until release.
func holdSpawn(t *testing.T, p *flakyProjects) (release func()) {
	t.Helper()
	gate := make(chan struct{})
	p.OnFetch = func(ctx context.Context, _ project.CreateWorktreeOptions) error {
		select {
		case <-gate:
		case <-ctx.Done():
		}
		return ctx.Err()
	}
	done := false
	release = func() {
		if !done {
			done = true
			close(gate)
		}
	}
	t.Cleanup(release)
	return release
}

func waitBusFor[T any](t *testing.T, sub *bus.Subscription[T], match func(T) bool) {
	t.Helper()
	deadline := time.After(5 * time.Second)
	for {
		select {
		case ev := <-sub.C():
			if match(ev) {
				return
			}
		case <-deadline:
			t.Fatal("timed out waiting for the event")
		}
	}
}

func TestRetryAfterCancelStartsOver(t *testing.T) {
	e, flaky, named := flakyEnv(t)
	started, release := gateFetches(flaky.recordingProjects)
	s, err := e.m.Create(e.ctx(), CreateOptions{ProjectID: "r1", InitialPrompt: "do x", NewWorktree: &NewWorktree{}, BackgroundSetup: true})
	if err != nil {
		t.Fatal(err)
	}
	waitChan(t, started, "the fetch")
	e.waitFor(s.ID, "the namer", func(s Thread) bool { return stepStatus(s, SetupStepName, "") == SetupStepDone })
	c, kept, err := e.m.CancelSetup(e.ctx(), s.ID)
	if err != nil || len(kept) != 0 {
		t.Fatalf("CancelSetup = %v, kept %q", err, kept)
	}
	if c.Setup.Phase != SetupCancelled {
		t.Fatalf("setup %+v", c.Setup)
	}
	before := named.Load()
	release()
	if _, err := e.m.RetrySetup(e.ctx(), s.ID); err != nil {
		t.Fatal(err)
	}
	after, _ := e.m.Get(e.ctx(), s.ID)
	if after.Setup.Phase == SetupRunning && slices.ContainsFunc(after.Setup.Steps, func(st SetupStep) bool { return st.Status == SetupStepFailed }) {
		t.Errorf("steps %+v", after.Setup.Steps)
	}
	done := e.waitFor(s.ID, "the retry to land", func(s Thread) bool { return s.Setup.Phase == SetupDone })
	if named.Load() <= before {
		t.Errorf("namer did not run again: %d, was %d", named.Load(), before)
	}
	if done.Branch == "" || done.WorktreePath == "" || !done.CreatedWorktree {
		t.Errorf("placement %+v", done)
	}
	for _, st := range done.Setup.Steps {
		if st.Status != SetupStepDone && st.Status != SetupStepWarning {
			t.Errorf("step %+v", st)
		}
	}
	e.waitUserText("do x")
}

// A setup at its worktree when the daemon dies: the row says the add began, a retry takes
// away what it left before going on, and what was running is the failed step.
func TestRetryAfterARestart(t *testing.T) {
	var held *heldProjects
	e, _ := newWorktreeEnv(t, nil, func(o *Options) {
		held = &heldProjects{recordingProjects: o.Projects.(*recordingProjects), holding: "r2"}
		o.Projects = held
	})
	e.addGitProject(t, "r2", "other")
	var named atomic.Int32
	e.namer = untitledNamer(&named)
	s, err := e.m.Create(e.ctx(), twoProjects())
	if err != nil {
		t.Fatal(err)
	}
	e.waitFor(s.ID, "r1's worktree", func(s Thread) bool { return stepStatus(s, SetupStepWorktree, "r1") == SetupStepDone })
	row, _ := e.m.Get(e.ctx(), s.ID)
	ctx, cancel := context.WithTimeout(context.Background(), 3*time.Second)
	defer cancel()
	if err := e.m.Shutdown(ctx); err != nil {
		t.Fatal(err)
	}
	// As the daemon's death leaves the row: a stop would have ended the add.
	path := filepath.Join(e.projects.WorktreeRoot, "lost")
	row.Setup = row.Setup.edit(func(c *Setup) {
		c.Adding = []SetupAdd{{ProjectID: "r2", Path: path, Branch: "fix-login", Head: "abc"}}
		c.step(SetupStepWorktree, "r2").begin(time.Now())
	})
	if err := saveThread(ctx, e.m.opts.DB, row); err != nil {
		t.Fatal(err)
	}
	e.open(func(o *Options) { o.Projects = held.recordingProjects })
	lost, err := e.m.Get(e.ctx(), s.ID)
	if err != nil {
		t.Fatal(err)
	}
	if lost.Setup.Phase != SetupFailed || stepStatus(lost, SetupStepWorktree, "r2") != SetupStepFailed {
		t.Fatalf("after the restart: %+v", lost.Setup)
	}
	if lost.Setup.step(SetupStepWorktree, "r2").Error != SetupRestarted {
		t.Errorf("step %+v", lost.Setup.step(SetupStepWorktree, "r2"))
	}
	if _, err := e.m.RetrySetup(e.ctx(), s.ID); err != nil {
		t.Fatal(err)
	}
	done := e.waitFor(s.ID, "the retry to land", func(s Thread) bool { return s.Setup.Phase == SetupDone })
	if !slices.Contains(held.Calls, "AbandonWorktree r2 "+path+" fix-login") {
		t.Errorf("calls %q", held.Calls)
	}
	if countCalls(held.Calls, "RemoveWorktree") != 0 {
		t.Errorf("calls %q", held.Calls)
	}
	if n := named.Load(); n != 1 {
		t.Errorf("namer ran %d times", n)
	}
	if done.Branch != lost.Setup.step(SetupStepName, "").Branch {
		t.Errorf("branch %q, named %q", done.Branch, lost.Setup.step(SetupStepName, "").Branch)
	}
	e.waitUserText("do x")
	noSecondNamer(t, e, s.ID, &named)
}

// untitledNamer counts its calls and names nothing, so the thread stays provisional and
// only namingTried keeps a second call away: a title would end naming by itself.
func untitledNamer(n *atomic.Int32) func(string) (string, error) {
	return func(string) (string, error) {
		n.Add(1)
		return "", errors.New("no name today")
	}
}

// noSecondNamer does what the runner does when it reads the first message in the
// transcript, which the fake never writes, then waits for any naming to end: Shutdown waits
// for it, so the count is final.
func noSecondNamer(t *testing.T, e *env, id string, named *atomic.Int32) {
	t.Helper()
	if s, _ := e.m.Get(e.ctx(), id); s.namedForGood() {
		t.Fatalf("named %q: this proves nothing", s.Name)
	}
	e.m.startNaming(id, "do x")
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	if err := e.m.Shutdown(ctx); err != nil {
		t.Fatal(err)
	}
	if n := named.Load(); n != 1 {
		t.Errorf("namer ran %d times", n)
	}
	e.open()
}

// The thread a Like copied is gone by the retry: that is a setup failure saying so.
func TestRetryWhenLikeIsGone(t *testing.T) {
	e, rr := newWorktreeEnv(t, nil)
	src := e.create(CreateOptions{ProjectID: "r1", NewWorktree: &NewWorktree{}})
	rr.mu.Lock()
	rr.err = errors.New("git says no")
	rr.mu.Unlock()
	s, err := e.m.Create(e.ctx(), CreateOptions{Like: src.ID, NewBranch: true, InitialPrompt: "do x", BackgroundSetup: true})
	if err != nil {
		t.Fatal(err)
	}
	e.waitFor(s.ID, "the setup to fail", func(s Thread) bool { return s.Setup.Phase == SetupFailed })
	if err := e.m.Remove(e.ctx(), src.ID); err != nil {
		t.Fatal(err)
	}
	rr.mu.Lock()
	rr.err = nil
	rr.mu.Unlock()
	if _, err := e.m.RetrySetup(e.ctx(), s.ID); err != nil {
		t.Fatal(err)
	}
	got := e.waitFor(s.ID, "the retry to fail", func(s Thread) bool { return s.Setup.Phase == SetupFailed })
	if !strings.Contains(got.Setup.Error, "like: thread "+src.ID+" not found") || strings.Contains(got.Setup.Error, "invalid argument") {
		t.Errorf("error %q", got.Setup.Error)
	}
	if got.Status != StatusError || got.StatusReason != ReasonSetupFailed || got.State != StateDisconnected {
		t.Errorf("status %v %q, state %v", got.Status, got.StatusReason, got.State)
	}
	if !slices.ContainsFunc(got.Setup.Steps, func(st SetupStep) bool { return st.Status == SetupStepFailed }) {
		t.Errorf("no step shows it: %+v", got.Setup.Steps)
	}
}

// A retry that fails is a failed setup like the first: what it made stays, one turn end,
// and the next retry works.
func TestRetryThatFails(t *testing.T) {
	e, flaky, named := flakyEnv(t)
	s := failedOnR2(t, e, flaky)
	if _, err := e.m.RetrySetup(e.ctx(), s.ID); err != nil {
		t.Fatal(err)
	}
	again := e.waitFor(s.ID, "the retry to fail", func(s Thread) bool { return s.Setup.Phase == SetupFailed })
	if len(again.Setup.Made) != 1 || stepStatus(again, SetupStepWorktree, "r1") != SetupStepDone || stepStatus(again, SetupStepWorktree, "r2") != SetupStepFailed {
		t.Errorf("setup %+v", again.Setup)
	}
	if n := countTurnEnds(e.items(s.ID).Items); n != 1 {
		t.Errorf("%d turn ends:\n%s", n, describeItems(e.items(s.ID).Items))
	}
	flaky.heal()
	if _, err := e.m.RetrySetup(e.ctx(), s.ID); err != nil {
		t.Fatal(err)
	}
	e.waitFor(s.ID, "the second retry to land", func(s Thread) bool { return s.Setup.Phase == SetupDone })
	if n := named.Load(); n != 1 {
		t.Errorf("namer ran %d times", n)
	}
}

// A spawn that failed left the placement on the row: only the start is left, even after a
// restart, which forgets that the namer ran.
func TestRetryAfterASpawnFailure(t *testing.T) {
	e, _ := newWorktreeEnv(t, nil, func(o *Options) { o.Claude = "/nonexistent/claude" })
	var named atomic.Int32
	e.namer = untitledNamer(&named)
	s := failedSpawn(t, e)
	e.restart(func(o *Options) { o.Claude = fakeClaudeBin })
	if _, err := e.m.RetrySetup(e.ctx(), s.ID); err != nil {
		t.Fatal(err)
	}
	done := e.waitFor(s.ID, "the retry to land", func(s Thread) bool { return s.Setup.Phase == SetupDone })
	if done.WorktreePath != s.WorktreePath || done.Branch != s.Branch {
		t.Errorf("placed at %q on %q, was %q on %q", done.WorktreePath, done.Branch, s.WorktreePath, s.Branch)
	}
	if n := len(e.projects.Creates); n != 1 {
		t.Errorf("%d worktrees made", n)
	}
	e.waitUserText("do x")
	noSecondNamer(t, e, s.ID, &named)
}

// A worktree made by the first run that went since (by hand, with an archive) is made again.
func TestRetryMakesAgainWhatWentMeanwhile(t *testing.T) {
	e, flaky, _ := flakyEnv(t)
	s := failedOnR2(t, e, flaky)
	if err := flaky.RemoveWorktree(e.ctx(), project.RemoveWorktreeOptions{ProjectID: "r1", Path: s.Setup.Made[0].Path, Force: true}); err != nil {
		t.Fatal(err)
	}
	flaky.heal()
	if _, err := e.m.RetrySetup(e.ctx(), s.ID); err != nil {
		t.Fatal(err)
	}
	done := e.waitFor(s.ID, "the retry to land", func(s Thread) bool { return s.Setup.Phase == SetupDone })
	if p, _ := done.CheckoutPath("r1"); !isDir(p) {
		t.Errorf("r1's checkout %q", p)
	}
}

func TestRetryRefusals(t *testing.T) {
	e, rr := newWorktreeEnv(t, nil)
	done := e.create(CreateOptions{ProjectID: "r1", NewWorktree: &NewWorktree{}})
	s, release := inSetup(t, e, rr, CreateOptions{InitialPrompt: "do x"})
	plain := e.create(CreateOptions{Name: "plain"})
	e.m.update(plain.ID, true, func(r *record) { r.s.Setup = nil })
	for _, id := range []string{done.ID, s.ID, plain.ID} {
		if _, err := e.m.RetrySetup(e.ctx(), id); !errors.Is(err, ErrFailedPrecondition) {
			t.Errorf("RetrySetup(%s) = %v", id, err)
		}
		if _, err := e.m.DiscardSetup(e.ctx(), id); !errors.Is(err, ErrFailedPrecondition) {
			t.Errorf("DiscardSetup(%s) = %v", id, err)
		}
	}
	if _, err := e.m.RetrySetup(e.ctx(), "s-gone"); !errors.Is(err, ErrNotFound) {
		t.Errorf("RetrySetup = %v", err)
	}
	release()
}

// cancelStages are the stages a cancel can catch a setup in, each with what holds it there.
var cancelStages = []struct {
	name string
	hold func(t *testing.T, e *env, rr *recordingProjects) (o CreateOptions, wait func(id string))
}{
	{"naming", func(t *testing.T, e *env, _ *recordingProjects) (CreateOptions, func(string)) {
		in := make(chan struct{})
		gate := make(chan struct{})
		t.Cleanup(func() { close(gate) })
		e.namer = func(string) (string, error) {
			close(in)
			<-gate
			return "", errors.New("late")
		}
		return CreateOptions{ProjectID: "r1", NewWorktree: &NewWorktree{}}, func(string) { waitChan(t, in, "the namer") }
	}},
	{"fetch", func(t *testing.T, e *env, rr *recordingProjects) (CreateOptions, func(string)) {
		started, release := gateFetches(rr)
		t.Cleanup(release)
		return CreateOptions{ProjectID: "r1", NewWorktree: &NewWorktree{}}, func(string) { waitChan(t, started, "the fetch") }
	}},
	{"worktree", func(t *testing.T, e *env, _ *recordingProjects) (CreateOptions, func(string)) {
		// r1's is made and r2's is under way: the one made has to go.
		return CreateOptions{ProjectIDs: []string{"r1", "r2"}, NewWorktree: &NewWorktree{}}, func(id string) {
			e.waitFor(id, "r1's worktree", func(s Thread) bool { return stepStatus(s, SetupStepWorktree, "r1") == SetupStepDone })
		}
	}},
}

func TestCancelAtEachStage(t *testing.T) {
	for _, tt := range cancelStages {
		t.Run(tt.name, func(t *testing.T) {
			var held *heldProjects
			e, rr := newWorktreeEnv(t, nil, func(o *Options) {
				held = &heldProjects{recordingProjects: o.Projects.(*recordingProjects), holding: "r2"}
				o.Projects = held
			})
			e.addGitProject(t, "r2", "other")
			o, wait := tt.hold(t, e, rr)
			o.InitialPrompt, o.BackgroundSetup = "do x", true
			s, err := e.m.Create(e.ctx(), o)
			if err != nil {
				t.Fatal(err)
			}
			wait(s.ID)
			got, kept, err := e.m.CancelSetup(e.ctx(), s.ID)
			if err != nil {
				t.Fatal(err)
			}
			if len(kept) != 0 {
				t.Errorf("kept %q", kept)
			}
			if got.Setup.Phase != SetupCancelled || got.Setup.EndedAt.IsZero() || got.Setup.Made != nil || got.Setup.Error != "" {
				t.Errorf("setup %+v", got.Setup)
			}
			if got.State != StateDisconnected || got.DisconnectReason != ReasonSetupCancelled || got.LastError != "" {
				t.Errorf("state %v, disconnect %q, last error %q", got.State, got.DisconnectReason, got.LastError)
			}
			// Deliberate: quiet, and settled.
			if got.Status != StatusIdle || got.StatusReason != ReasonSetupCancelled {
				t.Errorf("status %v %q", got.Status, got.StatusReason)
			}
			if !Meets(CondSettled, got) || Meets(CondError, got) || Meets(CondAttention, got) {
				t.Errorf("conditions: settled %v, error %v, attention %v", Meets(CondSettled, got), Meets(CondError, got), Meets(CondAttention, got))
			}
			if n := countTurnEnds(e.items(s.ID).Items); n != 1 {
				t.Errorf("%d turn ends: a wait has no reaction to count", n)
			}
			if slices.ContainsFunc(got.Setup.Steps, func(st SetupStep) bool {
				return st.Status == SetupStepRunning || st.Status == SetupStepFailed || st.Status == SetupStepWarning
			}) {
				t.Errorf("steps %+v", got.Setup.Steps)
			}
			if n := worktreeCount(rr, "r1"); n != 1 {
				t.Errorf("r1 has %d worktrees", n)
			}
			if got.WorktreePath != "" || got.Branch != "" || got.CreatedWorktree || !got.unplaced() {
				t.Errorf("placement %+v", got)
			}
			if e.spawnCount() != 0 {
				t.Errorf("%d spawns", e.spawnCount())
			}
			rows, _ := loadThreads(e.ctx(), e.m.opts.DB)
			if len(rows) != 1 || rows[0].Setup.Phase != SetupCancelled {
				t.Errorf("rows %+v", rows)
			}
		})
	}
}

// A clean stop cuts off whatever runs. Nothing says so on the step at the time: the next
// start gives it the reason, and "context canceled" reaches nobody. The step is checked
// by kind: naming runs beside the fetch, and a stop before it ends fails it too.
func TestStoppedDaemonGivesTheStepTheRestart(t *testing.T) {
	tests := []struct {
		name    string
		kind    SetupStepKind
		project string
		hold    func(t *testing.T, e *env, rr *recordingProjects) string
	}{
		{"a fetch", SetupStepFetch, "r1", func(t *testing.T, e *env, rr *recordingProjects) string {
			s, _ := inSetup(t, e, rr, CreateOptions{InitialPrompt: "do x"})
			// Running on the row, not only in the projects fake: the row is what the
			// next start reads.
			waitForStep(t, e, s.ID, SetupStepFetch, "r1", SetupStepRunning)
			return s.ID
		}},
		// The held add never reports adding: the step is pending, the first one the
		// restart fails when none runs.
		{"a worktree add", SetupStepWorktree, "r2", func(t *testing.T, e *env, _ *recordingProjects) string {
			s, err := e.m.Create(e.ctx(), CreateOptions{ProjectID: "r2", InitialPrompt: "do x", NewWorktree: &NewWorktree{}, BackgroundSetup: true})
			if err != nil {
				t.Fatal(err)
			}
			waitInStack(t, "(*heldProjects).CreateWorktree")
			return s.ID
		}},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			e, rr := newWorktreeEnv(t, nil, func(o *Options) {
				o.Projects = &heldProjects{recordingProjects: o.Projects.(*recordingProjects), holding: "r2"}
			})
			e.addGitProject(t, "r2", "other")
			id := tt.hold(t, e, rr)
			e.restart()
			got, err := e.m.Get(e.ctx(), id)
			if err != nil {
				t.Fatal(err)
			}
			if got.Setup.Phase != SetupFailed || got.Setup.Error != SetupRestarted {
				t.Fatalf("setup %+v", got.Setup)
			}
			if st := got.Setup.step(tt.kind, tt.project); st == nil || st.Status != SetupStepFailed || st.Error != SetupRestarted {
				t.Errorf("step %v of %s: %+v, want failed with the restart (steps %+v)", tt.kind, tt.project, st, got.Setup.Steps)
			}
		})
	}
}

// A step the setup stopped keeps its time until the setup has ended: a cancel's cleanup
// can take a while, and a step that lost its time looks like one that never ran.
func TestStoppedStepsKeepTheirTimes(t *testing.T) {
	e, rr := newWorktreeEnv(t, nil)
	s, _ := inSetup(t, e, rr, CreateOptions{InitialPrompt: "do x"})
	waitForStep(t, e, s.ID, SetupStepFetch, "r1", SetupStepRunning)
	tr := &setupTracker{m: e.m, id: s.ID}
	tr.progress("r1")(project.WorktreeEvent{Kind: project.WorktreeFetchEnded, Remote: "origin", Err: context.Canceled})
	got, _ := e.m.Get(e.ctx(), s.ID)
	st := got.Setup.step(SetupStepFetch, "r1")
	if st.Status != SetupStepRunning || st.StartedAt.IsZero() || st.Warning != "" {
		t.Errorf("fetch %+v", st)
	}
}

func TestArchiveCancelsABackgroundSetup(t *testing.T) {
	e, rr := newWorktreeEnv(t, nil)
	s, _ := inSetup(t, e, rr, CreateOptions{InitialPrompt: "do x"}) // its fetch never ends by itself
	got, err := e.m.Archive(e.ctx(), s.ID, true)
	if err != nil {
		t.Fatal(err)
	}
	if got.ArchivedAt.IsZero() || got.Setup.Phase != SetupCancelled {
		t.Errorf("archived at %v, setup %+v", got.ArchivedAt, got.Setup)
	}
	if n := worktreeCount(rr, "r1"); n != 1 {
		t.Errorf("r1 has %d worktrees", n)
	}
	if e.spawnCount() != 0 {
		t.Errorf("%d spawns", e.spawnCount())
	}
	// A retry brings it back, as for any stopped setup.
	if _, err := e.m.RetrySetup(e.ctx(), s.ID); err != nil {
		t.Fatal(err)
	}
	if back, _ := e.m.Get(e.ctx(), s.ID); !back.ArchivedAt.IsZero() {
		t.Errorf("archived at %v after a retry", back.ArchivedAt)
	}
}

func TestCancelRefusals(t *testing.T) {
	e, rr := newWorktreeEnv(t, nil)
	done := e.create(CreateOptions{ProjectID: "r1", NewWorktree: &NewWorktree{}})
	failed := failedSetup(t, e, rr)
	rr.mu.Lock()
	rr.err = nil
	rr.mu.Unlock()
	tests := []struct {
		name, id, want string
	}{
		{"past its spawn", done.ID, "interrupt it instead"},
		{"failed", failed.ID, "not running"},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			_, _, err := e.m.CancelSetup(e.ctx(), tt.id)
			if !errors.Is(err, ErrFailedPrecondition) || !strings.Contains(err.Error(), tt.want) {
				t.Errorf("CancelSetup = %v", err)
			}
		})
	}
	t.Run("its creator waits", func(t *testing.T) {
		started, release := gateFetches(rr)
		defer release()
		errc := make(chan error, 1)
		go func() {
			_, err := e.m.Create(context.Background(), CreateOptions{ProjectID: "r1", InitialPrompt: "do x", NewWorktree: &NewWorktree{}})
			errc <- err
		}()
		waitChan(t, started, "the fetch")
		i := slices.IndexFunc(e.m.Snapshot().Threads, func(s Thread) bool { return s.SettingUp() })
		id := e.m.Snapshot().Threads[i].ID
		if _, _, err := e.m.CancelSetup(e.ctx(), id); !errors.Is(err, ErrFailedPrecondition) {
			t.Errorf("CancelSetup = %v", err)
		}
		if _, err := e.m.Send(e.ctx(), id, Message{Text: "hi"}); !errors.Is(err, ErrFailedPrecondition) {
			t.Errorf("Send = %v", err)
		}
		release()
		if err := waitChan(t, errc, "Create"); err != nil {
			t.Errorf("Create = %v", err)
		}
	})
}

// A cancel at the moment the setup lands, again and again (run with -race): it is either
// cancelled with nothing left, or finished with the cancel told so, never half of each.
func TestCancelRacesTheLanding(t *testing.T) {
	e, rr := newWorktreeEnv(t, nil)
	cancelled, late := 0, 0
	for i := range 40 {
		s, err := e.m.Create(e.ctx(), CreateOptions{ProjectID: "r1", InitialPrompt: "do x", NewWorktree: &NewWorktree{Branch: fmt.Sprintf("race/b%d", i)}, BackgroundSetup: true})
		if err != nil {
			t.Fatal(err)
		}
		time.Sleep(time.Duration(i) * 50 * time.Microsecond)
		got, _, err := e.m.CancelSetup(e.ctx(), s.ID)
		switch {
		case err == nil:
			cancelled++
			if got.Setup.Phase != SetupCancelled || got.WorktreePath != "" || got.State != StateDisconnected {
				t.Fatalf("round %d: cancelled, but %+v", i, got)
			}
			if n := worktreeCount(rr, "r1"); n != 1+late {
				t.Fatalf("round %d: %d worktrees after %d that landed", i, n, late)
			}
		case errors.Is(err, ErrFailedPrecondition):
			late++
			now, _ := e.m.Get(e.ctx(), s.ID)
			if now.Setup.Phase != SetupDone || now.WorktreePath == "" || !strings.Contains(err.Error(), "too late") {
				t.Fatalf("round %d: %v, but %+v", i, err, now.Setup)
			}
		default:
			t.Fatalf("round %d: %v", i, err)
		}
	}
	t.Logf("%d cancelled, %d too late", cancelled, late)
}

// A cancel asked for just before spawn's commit wins it: the process it started goes, and
// so does what was made. The race above rarely lands there, so this one puts it there.
func TestCancelBeatsTheCommit(t *testing.T) {
	e, rr := newWorktreeEnv(t, nil)
	s, release := inSetup(t, e, rr, CreateOptions{InitialPrompt: "do x"})
	e.m.mu.Lock()
	j := e.m.recs[s.ID].setup
	j.cancelAsked = true // its ctx goes on: nothing stops the setup before the commit
	e.m.mu.Unlock()
	release()
	select {
	case <-j.done:
	case <-time.After(5 * time.Second):
		t.Fatal("the setup did not end")
	}
	got, err := e.m.Get(e.ctx(), s.ID)
	if err != nil {
		t.Fatal(err)
	}
	if got.Setup.Phase != SetupCancelled || got.State != StateDisconnected || got.WorktreePath != "" || got.Setup.Made != nil {
		t.Errorf("after the commit: %+v, setup %+v", got, got.Setup)
	}
	if n := worktreeCount(rr, "r1"); n != 1 {
		t.Errorf("r1 has %d worktrees", n)
	}
	if got.PendingFirst == nil {
		t.Error("the first message went: a retry has nothing to send")
	}
	if len(e.sentTexts()) != 0 {
		t.Errorf("Claude got %q", e.sentTexts())
	}
}

func TestDiscardGivesBackTheDraft(t *testing.T) {
	tests := []struct {
		name    string
		end     func(t *testing.T, e *env, s Thread)
		wantErr string
	}{
		{"failed", func(t *testing.T, e *env, s Thread) {
			e.waitFor(s.ID, "the setup to fail", func(s Thread) bool { return s.Setup.Phase == SetupFailed })
		}, "fatal: other refuses"},
		{"cancelled", func(t *testing.T, e *env, s Thread) {
			if _, _, err := e.m.CancelSetup(e.ctx(), s.ID); err != nil {
				t.Fatal(err)
			}
		}, ""},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			e, flaky, _ := flakyEnv(t, func(o *Options) { o.AttachmentsDir = filepath.Join(t.TempDir(), "att") })
			img, err := e.m.StageAttachment(e.ctx(), "a.png", "image/png", pngData, 0)
			if err != nil {
				t.Fatal(err)
			}
			img2, err := e.m.StageAttachment(e.ctx(), "b.png", "image/png", pngData, 0)
			if err != nil {
				t.Fatal(err)
			}
			o := twoProjects()
			o.Attachments, o.ComposerPrompt, o.DraftJSON = []string{img}, "do <x>", `{"text":"do x"}`
			var release func()
			if tt.wantErr != "" {
				flaky.fail("r2")
			} else {
				release = holdSpawn(t, flaky)
			}
			s, err := e.m.Create(e.ctx(), o)
			if err != nil {
				t.Fatal(err)
			}
			if release != nil {
				waitForStep(t, e, s.ID, SetupStepFetch, "r1", SetupStepRunning)
				if _, err := e.m.Send(e.ctx(), s.ID, Message{Text: "and y", ComposerText: "and <y>", Attachments: []string{img2}}); err != nil {
					t.Fatal(err)
				}
			}
			tt.end(t, e, s)
			if tt.wantErr != "" {
				// Sent after it failed: this one is a try again, which fails the same way.
				if _, err := e.m.Send(e.ctx(), s.ID, Message{Text: "and y", ComposerText: "and <y>", Attachments: []string{img2}}); err != nil {
					t.Fatal(err)
				}
				e.waitFor(s.ID, "the setup to fail again", func(s Thread) bool { return s.Setup.Phase == SetupFailed })
			}
			sub := bus.Subscribe[Event](e.bus, 256)
			defer sub.Close()
			d, err := e.m.DiscardSetup(e.ctx(), s.ID)
			if err != nil {
				t.Fatal(err)
			}
			if d.DraftJSON != `{"text":"do x"}` {
				t.Errorf("draft %q", d.DraftJSON)
			}
			if !strings.Contains(d.Error, tt.wantErr) || (tt.wantErr == "" && d.Error != "") {
				t.Errorf("error %q", d.Error)
			}
			if d.First == nil || d.First.Text != "do x" || d.First.ComposerText != "do <x>" || !slices.Equal(d.First.Attachments, []string{img}) {
				t.Errorf("first %+v", d.First)
			}
			if len(d.Queued) != 1 || d.Queued[0].Text != "and y" || d.Queued[0].ComposerText != "and <y>" || !slices.Equal(d.Queued[0].Attachments, []string{img2}) {
				t.Errorf("queued %+v", d.Queued)
			}
			for _, p := range []string{img, img2} {
				if _, err := os.Stat(p); err != nil {
					t.Errorf("attachment gone: %v", err)
				}
			}
			waitBusFor(t, sub, func(ev Event) bool { r, ok := ev.(Removed); return ok && r.ID == s.ID })
			if _, err := e.m.Get(e.ctx(), s.ID); !errors.Is(err, ErrNotFound) {
				t.Errorf("Get = %v", err)
			}
			if _, ok := e.m.Removed(s.ID); ok {
				t.Error("a tombstone: it was never made, as far as anyone is told")
			}
			if rows, err := loadThreads(e.ctx(), e.m.opts.DB); err != nil || len(rows) != 0 {
				t.Errorf("rows %+v, %v", rows, err)
			}
			if n := worktreeCount(flaky.recordingProjects, "r1"); n != 1 {
				t.Errorf("r1 has %d worktrees", n)
			}
		})
	}
}

// waitForStep waits for a step to reach status.
func waitForStep(t *testing.T, e *env, id string, kind SetupStepKind, projectID string, status SetupStepStatus) {
	t.Helper()
	e.waitFor(id, "the step", func(s Thread) bool { return stepStatus(s, kind, projectID) == status })
}

func TestRemoveCleansAFinishedSetup(t *testing.T) {
	tests := []struct {
		name string
		end  func(t *testing.T, e *env, flaky *flakyProjects) string
	}{
		{"failed", func(t *testing.T, e *env, flaky *flakyProjects) string { return failedOnR2(t, e, flaky).ID }},
		{"failed before a restart", func(t *testing.T, e *env, flaky *flakyProjects) string {
			id := failedOnR2(t, e, flaky).ID
			e.restart(func(o *Options) { o.Projects = flaky })
			return id
		}},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			e, flaky, _ := flakyEnv(t)
			id := tt.end(t, e, flaky)
			if n := worktreeCount(flaky.recordingProjects, "r1"); n != 2 {
				t.Fatalf("r1 has %d worktrees", n)
			}
			if err := e.m.Remove(e.ctx(), id); err != nil {
				t.Fatal(err)
			}
			if n := worktreeCount(flaky.recordingProjects, "r1"); n != 1 {
				t.Errorf("r1 has %d worktrees", n)
			}
			if !slices.ContainsFunc(flaky.Calls, func(c string) bool { return strings.HasPrefix(c, "DeleteMadeBranch r1") }) {
				t.Errorf("calls %q", flaky.Calls)
			}
			if _, ok := e.m.Removed(id); !ok {
				t.Error("a removed thread keeps its tombstone")
			}
		})
	}
}

// Thread B on A's branch shares the worktree A's setup made: none of the ways to end A's
// setup takes it from under B, nor deletes its branch.
func TestCleanupKeepsAWorktreeAnotherThreadHolds(t *testing.T) {
	ends := []struct {
		name string
		end  func(t *testing.T, e *env, id string)
	}{
		{"cancel", func(t *testing.T, e *env, id string) {
			if _, _, err := e.m.CancelSetup(e.ctx(), id); err != nil {
				t.Fatal(err)
			}
		}},
		{"discard", func(t *testing.T, e *env, id string) {
			finish(t, e, id)
			if _, err := e.m.DiscardSetup(e.ctx(), id); err != nil {
				t.Fatal(err)
			}
		}},
		{"remove", func(t *testing.T, e *env, id string) {
			finish(t, e, id)
			if err := e.m.Remove(e.ctx(), id); err != nil {
				t.Fatal(err)
			}
		}},
	}
	for _, tt := range ends {
		t.Run(tt.name, func(t *testing.T) {
			var held *heldProjects
			e, rr := newWorktreeEnv(t, nil, func(o *Options) {
				held = &heldProjects{recordingProjects: o.Projects.(*recordingProjects), holding: "r2"}
				o.Projects = held
			})
			e.addGitProject(t, "r2", "other")
			e.m.opts.RefExists = branchesOfWorktrees(rr)
			a, err := e.m.Create(e.ctx(), CreateOptions{ProjectIDs: []string{"r1", "r2"}, InitialPrompt: "do x", NewWorktree: &NewWorktree{Branch: "fix/shared"}, BackgroundSetup: true})
			if err != nil {
				t.Fatal(err)
			}
			a = e.waitFor(a.ID, "r1's worktree", func(s Thread) bool { return stepStatus(s, SetupStepWorktree, "r1") == SetupStepDone })
			path := a.Setup.Made[0].Path
			b := e.create(CreateOptions{ProjectID: "r1", NewWorktree: &NewWorktree{Branch: "fix/shared"}})
			if b.WorktreePath != path {
				t.Fatalf("B runs in %q, A's is %q", b.WorktreePath, path)
			}
			tt.end(t, e, a.ID)
			if countCalls(held.Calls, "RemoveWorktree r1") != 0 || countCalls(held.Calls, "DeleteMadeBranch") != 0 {
				t.Errorf("calls %q", held.Calls)
			}
			if !isDir(path) || worktreeCount(rr, "r1") != 2 {
				t.Errorf("the worktree went")
			}
		})
	}
}

// branchesOfWorktrees is a RefExists that knows the branches the fake's worktrees are on.
func branchesOfWorktrees(rr *recordingProjects) func(context.Context, string, string) bool {
	return func(_ context.Context, dir, ref string) bool {
		for _, p := range rr.Snapshot().Projects {
			if p.Path == dir && slices.ContainsFunc(p.Worktrees, func(w project.Worktree) bool { return ref == "refs/heads/"+w.Branch }) {
				return true
			}
		}
		return false
	}
}

// finish ends a held setup with a failure.
func finish(t *testing.T, e *env, id string) {
	t.Helper()
	e.m.mu.Lock()
	j := e.m.recs[id].setup
	e.m.mu.Unlock()
	j.cancel()
	e.waitFor(id, "the setup to end", func(s Thread) bool { return s.Setup.Phase == SetupFailed })
}

// A thread in setup has no checkouts yet, but its setup says which worktree it is about to
// work in.
func TestCleanupKeepsAWorktreeASetupHolds(t *testing.T) {
	e, flaky, _ := flakyEnv(t)
	a := failedOnR2(t, e, flaky)
	path := a.Setup.Made[0].Path
	flaky.heal()
	b, release := inSetup(t, e, flaky.recordingProjects, CreateOptions{InitialPrompt: "do y", NewWorktree: &NewWorktree{Branch: "other/branch"}})
	e.m.update(b.ID, true, func(r *record) {
		r.s.Setup = r.s.Setup.edit(func(c *Setup) { c.Held = []string{path} })
	})
	if _, err := e.m.DiscardSetup(e.ctx(), a.ID); err != nil {
		t.Fatal(err)
	}
	if countCalls(flaky.Calls, "RemoveWorktree") != 0 {
		t.Errorf("calls %q", flaky.Calls)
	}
	release()
}

// A worktree that was there before the setup is not the setup's to remove.
func TestCleanupKeepsWhatWasThereBefore(t *testing.T) {
	e, flaky, _ := flakyEnv(t)
	e.m.opts.RefExists = branchesOfWorktrees(flaky.recordingProjects)
	wt, err := flaky.CreateWorktree(e.ctx(), project.CreateWorktreeOptions{ProjectID: "r1", Branch: "fix/old"})
	if err != nil {
		t.Fatal(err)
	}
	flaky.fail("r2")
	o := twoProjects()
	o.NewWorktree = &NewWorktree{Branch: "fix/old"}
	s, err := e.m.Create(e.ctx(), o)
	if err != nil {
		t.Fatal(err)
	}
	failed := e.waitFor(s.ID, "the setup to fail", func(s Thread) bool { return s.Setup.Phase == SetupFailed })
	if len(failed.Setup.Made) != 0 {
		t.Fatalf("made %+v", failed.Setup.Made)
	}
	if _, err := e.m.DiscardSetup(e.ctx(), s.ID); err != nil {
		t.Fatal(err)
	}
	if countCalls(flaky.Calls, "RemoveWorktree") != 0 || !isDir(wt.Path) {
		t.Errorf("calls %q", flaky.Calls)
	}
}

// Work in a worktree stays: a cleanup never forces. Cancel and Discard say what stayed.
func TestCleanupKeepsWork(t *testing.T) {
	e, flaky, _ := flakyEnv(t)
	s := failedOnR2(t, e, flaky)
	path := s.Setup.Made[0].Path
	r, _ := flaky.Snapshot().Project("r1")
	for i := range r.Worktrees {
		if r.Worktrees[i].Path == path {
			r.Worktrees[i].Status.Modified = 1
		}
	}
	flaky.Put(r)
	d, err := e.m.DiscardSetup(e.ctx(), s.ID)
	if err != nil {
		t.Fatal(err)
	}
	if !slices.Equal(d.Kept, []string{path}) || !isDir(path) {
		t.Errorf("kept %q", d.Kept)
	}
	if n := worktreeCount(flaky.recordingProjects, "r1"); n != 2 {
		t.Errorf("r1 has %d worktrees", n)
	}
}

func TestSendDuringSetupQueues(t *testing.T) {
	e, rr := newWorktreeEnv(t, nil)
	s, release := inSetup(t, e, rr, CreateOptions{InitialPrompt: "first"})
	second, err := e.m.Send(e.ctx(), s.ID, Message{Text: "second", ComposerText: "<second>"})
	if err != nil {
		t.Fatal(err)
	}
	third, err := e.m.Send(e.ctx(), s.ID, Message{Text: "third", ByThreadID: "s-other"})
	if err != nil {
		t.Fatal(err)
	}
	if !second.Queued || !third.Queued || second.Kind != KindUserMessage {
		t.Errorf("items %+v, %+v", second, third)
	}
	items := e.items(s.ID).Items
	var users []string
	for _, it := range items {
		if it.Kind == KindUserMessage {
			users = append(users, it.Text)
		}
	}
	if !slices.Equal(users, []string{"first", "second", "third"}) {
		t.Errorf("timeline:\n%s", describeItems(items))
	}
	rows, err := loadThreads(e.ctx(), e.m.opts.DB)
	if err != nil || len(rows) != 1 || len(rows[0].Setup.Queued) != 2 {
		t.Fatalf("rows %+v, %v", rows, err)
	}
	release()
	e.waitFor(s.ID, "the messages to go out", func(s Thread) bool { return s.Setup.Phase == SetupDone && len(s.Setup.Queued) == 0 })
	if got := e.sentTextsN(3); !slices.Equal(got, []string{"first", "second", "third"}) {
		t.Errorf("sent %q", got)
	}
	if rows, _ := loadThreads(e.ctx(), e.m.opts.DB); len(rows[0].Setup.Queued) != 0 {
		t.Errorf("still on the row: %+v", rows[0].Setup.Queued)
	}
	// Once, in the timeline too.
	n := 0
	for _, it := range e.items(s.ID).Items {
		if it.Kind == KindUserMessage {
			n++
		}
	}
	if n != 3 {
		t.Errorf("%d user items", n)
	}
}

// A thread created without a prompt: the first message sent during its setup is the first
// Claude gets.
func TestSendDuringSetupWithoutAPrompt(t *testing.T) {
	e, rr := newWorktreeEnv(t, nil)
	s, release := inSetup(t, e, rr, CreateOptions{})
	if _, err := e.m.Send(e.ctx(), s.ID, Message{Text: "hello"}); err != nil {
		t.Fatal(err)
	}
	release()
	e.waitUserText("hello")
	if got := e.sentTextsN(1); !slices.Equal(got, []string{"hello"}) {
		t.Errorf("sent %q", got)
	}
}

func TestSendDuringSetupRewritesRefs(t *testing.T) {
	e, rr := newWorktreeEnv(t, nil)
	s, release := inSetup(t, e, rr, CreateOptions{InitialPrompt: "first"})
	if _, err := e.m.Send(e.ctx(), s.ID, Message{Text: "read cf-file://r1/a.go"}); err != nil {
		t.Fatal(err)
	}
	release()
	done := e.waitFor(s.ID, "the setup to end", func(s Thread) bool { return s.Setup.Phase == SetupDone })
	e.waitUserText("read " + done.WorktreePath + "/a.go")
}

func TestSendDuringSetupSurvivesARestart(t *testing.T) {
	e, rr := newWorktreeEnv(t, nil)
	s, _ := inSetup(t, e, rr, CreateOptions{InitialPrompt: "first"})
	q, err := e.m.Send(e.ctx(), s.ID, Message{Text: "second"})
	if err != nil {
		t.Fatal(err)
	}
	e.restart()
	got, err := e.m.Get(e.ctx(), s.ID)
	if err != nil || got.Setup.Phase != SetupFailed || len(got.Setup.Queued) != 1 {
		t.Fatalf("after the restart: %+v, %v", got.Setup, err)
	}
	item, ok := e.m.mustLog(t, s.ID).get(q.ID)
	if !ok || !item.Queued {
		t.Errorf("item %+v", item)
	}
	rr.OnFetch = nil
	if _, err := e.m.RetrySetup(e.ctx(), s.ID); err != nil {
		t.Fatal(err)
	}
	e.waitFor(s.ID, "the messages to go out", func(s Thread) bool { return s.Setup.Phase == SetupDone && len(s.Setup.Queued) == 0 })
	if got := e.sentTextsN(2); !slices.Equal(got, []string{"first", "second"}) {
		t.Errorf("sent %q", got)
	}
}

// mustLog is thread id's log.
func (m *Manager) mustLog(t *testing.T, id string) *threadLog {
	t.Helper()
	log, err := m.thread(context.Background(), id)
	if err != nil {
		t.Fatal(err)
	}
	return log
}

// Past spawn's commit and before the handshake the row still has what Claude does not: a
// daemon stop there keeps it, and the next start sends it, once, behind the first message.
func TestSendDuringSetupGoesAtTheNextStart(t *testing.T) {
	gate := initGate(t)
	var rr *recordingProjects
	e := newFixtureEnvAt(t, hangFixture(t), []string{"CF_FAKE_CLAUDE_INIT_GATE=" + gate.path}, func(o *Options) {
		rr = &recordingProjects{Fake: o.Projects.(*projecttest.Fake)}
		rr.WorktreeRoot = t.TempDir()
		o.Projects = rr
		o.SlugTimeout = 300 * time.Millisecond
		o.RefExists = func(context.Context, string, string) bool { return false }
	})
	t.Cleanup(gate.open)
	s, release := inSetup(t, e, rr, CreateOptions{InitialPrompt: "first"})
	if _, err := e.m.Send(e.ctx(), s.ID, Message{Text: "second"}); err != nil {
		t.Fatal(err)
	}
	release()
	e.waitFor(s.ID, "the spawn", func(s Thread) bool { return s.Setup.Phase == SetupDone })
	e.restart()
	got, err := e.m.Get(e.ctx(), s.ID)
	if err != nil || got.PendingFirst == nil || len(got.Setup.Queued) != 1 || got.Setup.Queued[0].Text != "second" {
		t.Fatalf("after the stop: %+v, %+v, %v", got.PendingFirst, got.Setup, err)
	}
	gate.open()
	if _, err := e.m.Send(e.ctx(), s.ID, Message{Text: "third"}); err != nil {
		t.Fatal(err)
	}
	e.sentUser("third")
	if got := e.sentTextsN(3); !slices.Equal(got, []string{"first", "second", "third"}) {
		t.Errorf("sent %q", got)
	}
	e.waitFor(s.ID, "the row to empty", func(s Thread) bool { return s.PendingFirst == nil && len(s.Setup.Queued) == 0 })
	if users := userItems(e.items(s.ID).Items); !slices.Equal(users, []string{"first", "second", "third"}) {
		t.Errorf("user items %q", users)
	}
}

func TestSendAfterItFailedTriesAgain(t *testing.T) {
	e, flaky, _ := flakyEnv(t)
	s := failedOnR2(t, e, flaky)
	flaky.heal()
	it, err := e.m.Send(e.ctx(), s.ID, Message{Text: "second"})
	if err != nil {
		t.Fatal(err)
	}
	if !it.Queued {
		t.Errorf("item %+v", it)
	}
	e.waitFor(s.ID, "the setup to land", func(s Thread) bool { return s.Setup.Phase == SetupDone && len(s.Setup.Queued) == 0 })
	if got := e.sentTextsN(2); !slices.Equal(got, []string{"do x", "second"}) {
		t.Errorf("sent %q", got)
	}
}

func TestSendAfterACancelStartsOver(t *testing.T) {
	e, rr := newWorktreeEnv(t, nil)
	s, release := inSetup(t, e, rr, CreateOptions{InitialPrompt: "first"})
	if _, _, err := e.m.CancelSetup(e.ctx(), s.ID); err != nil {
		t.Fatal(err)
	}
	release()
	if _, err := e.m.Send(e.ctx(), s.ID, Message{Text: "second"}); err != nil {
		t.Fatal(err)
	}
	e.waitFor(s.ID, "the setup to land", func(s Thread) bool { return s.Setup.Phase == SetupDone && len(s.Setup.Queued) == 0 })
	if got := e.sentTextsN(2); !slices.Equal(got, []string{"first", "second"}) {
		t.Errorf("sent %q", got)
	}
}

// A wake is no user asking to try again, and an archived failed setup comes back with a
// message.
func TestSendToAFailedSetupWhoAsks(t *testing.T) {
	e, flaky, _ := flakyEnv(t)
	s := failedOnR2(t, e, flaky)
	if _, err := e.m.Send(e.ctx(), s.ID, Message{Text: "woken", Origin: OriginWake}); !errors.Is(err, ErrFailedPrecondition) {
		t.Errorf("a wake: %v", err)
	}
	if got, _ := e.m.Get(e.ctx(), s.ID); got.Setup.Phase != SetupFailed {
		t.Errorf("a wake tried again: %+v", got.Setup)
	}
	if _, err := e.m.Archive(e.ctx(), s.ID, true); err != nil {
		t.Fatal(err)
	}
	flaky.heal()
	if _, err := e.m.Send(e.ctx(), s.ID, Message{Text: "back"}); err != nil {
		t.Fatal(err)
	}
	got := e.waitFor(s.ID, "the setup to land", func(s Thread) bool { return s.Setup.Phase == SetupDone })
	if !got.ArchivedAt.IsZero() {
		t.Errorf("archived at %v", got.ArchivedAt)
	}
}

// Messages sent as the setup lands, again and again (run with -race): each reaches Claude
// exactly once, whichever side of spawn's commit it landed on.
func TestSendRacesTheLanding(t *testing.T) {
	e, _ := newWorktreeEnv(t, nil)
	var want []string
	for i := range 25 {
		s, err := e.m.Create(e.ctx(), CreateOptions{ProjectID: "r1", NewWorktree: &NewWorktree{Branch: fmt.Sprintf("race/s%d", i)}, BackgroundSetup: true})
		if err != nil {
			t.Fatal(err)
		}
		time.Sleep(time.Duration(i) * 40 * time.Microsecond)
		for j := range 2 {
			text := fmt.Sprintf("m%d-%d", i, j)
			want = append(want, text)
			if _, err := e.m.Send(e.ctx(), s.ID, Message{Text: text}); err != nil {
				t.Fatalf("Send(%s) = %v", text, err)
			}
		}
		e.waitFor(s.ID, "the row to empty", func(s Thread) bool { return s.Setup.Phase == SetupDone && len(s.Setup.Queued) == 0 })
	}
	got := e.sentTextsN(len(want))
	slices.Sort(got)
	slices.Sort(want)
	if !slices.Equal(got, want) {
		t.Errorf("sent %q\nwant %q", got, want)
	}
}

// A Create that waited died with the daemon: its caller never heard of the thread, so the
// next start takes it away with what it made. A background one stays failed.
func TestBlockingSetupDiscardedAtStart(t *testing.T) {
	e, flaky, _ := flakyEnv(t)
	release := holdSpawn(t, flaky)
	o := twoProjects()
	o.BackgroundSetup = false
	errc := make(chan error, 1)
	go func() {
		_, err := e.m.Create(context.Background(), o)
		errc <- err
	}()
	for len(e.m.Snapshot().Threads) == 0 {
		time.Sleep(time.Millisecond)
	}
	s := e.m.Snapshot().Threads[0]
	waitForStep(t, e, s.ID, SetupStepFetch, "r1", SetupStepRunning)
	s, _ = e.m.Get(e.ctx(), s.ID)
	// As the daemon's death leaves the row: running, with a worktree made and an add begun.
	row := s
	made, path := filepath.Join(e.projects.WorktreeRoot, "made"), filepath.Join(e.projects.WorktreeRoot, "half")
	if err := os.MkdirAll(made, 0o755); err != nil {
		t.Fatal(err)
	}
	r, _ := flaky.Snapshot().Project("r1")
	r.Worktrees = append(r.Worktrees, project.Worktree{ProjectID: "r1", Path: made, Branch: "fix/login"})
	flaky.Put(r)
	row.Setup = row.Setup.edit(func(c *Setup) {
		c.Made = []SetupWorktree{{ProjectID: "r1", Path: made, Branch: "fix/login", NewBranch: true}}
		c.Adding = []SetupAdd{{ProjectID: "r2", Path: path, Branch: "fix/login", Head: "abc"}}
	})
	release()
	<-errc
	ctx, cancel := context.WithTimeout(context.Background(), 3*time.Second)
	defer cancel()
	if err := e.m.Shutdown(ctx); err != nil {
		t.Fatal(err)
	}
	if err := saveThread(ctx, e.m.opts.DB, row); err != nil {
		t.Fatal(err)
	}
	e.open(func(o *Options) { o.Projects = flaky })
	deadline := time.Now().Add(5 * time.Second)
	for len(e.m.Snapshot().Threads) > 0 || countCalls(flaky.Calls, "AbandonWorktree") == 0 {
		if time.Now().After(deadline) {
			t.Fatalf("threads %+v, calls %q", e.m.Snapshot().Threads, flaky.Calls)
		}
		time.Sleep(5 * time.Millisecond)
	}
	if !slices.Contains(flaky.Calls, "RemoveWorktree r1 "+made) || !slices.Contains(flaky.Calls, "AbandonWorktree r2 "+path+" fix/login") {
		t.Errorf("calls %q", flaky.Calls)
	}
	if rows, err := loadThreads(context.Background(), e.m.opts.DB); err != nil || len(rows) != 0 {
		t.Errorf("rows %+v, %v", rows, err)
	}
	if _, ok := e.m.Removed(s.ID); ok {
		t.Error("a tombstone")
	}
}

// A child whose Create waits, and fails, under an archive of its parent: nothing to archive
// and no failure of the archive's. Only Remove keeps the record through it.
func TestArchiveCascadeOverAFailedCreate(t *testing.T) {
	e, rr := newWorktreeEnv(t, nil)
	parent := e.connected(CreateOptions{ProjectID: "r1", NewWorktree: &NewWorktree{}})
	started, release := gateFetches(rr)
	defer release()
	errc := make(chan error, 1)
	go func() {
		_, err := e.m.Create(context.Background(), CreateOptions{ProjectID: "r1", CreatedBy: parent.ID, InitialPrompt: "do x", NewWorktree: &NewWorktree{}})
		errc <- err
	}()
	waitChan(t, started, "the fetch")
	type res struct {
		t   Thread
		err error
	}
	got := make(chan res, 1)
	go func() {
		a, err := e.m.Archive(context.Background(), parent.ID, true)
		got <- res{a, err}
	}()
	waitInStack(t, "(*Manager).endSetup") // Archive is waiting for the child's setup
	rr.mu.Lock()
	rr.err = errors.New("git says no")
	rr.mu.Unlock()
	release()
	if err := waitChan(t, errc, "Create"); err == nil {
		t.Fatal("Create succeeded")
	}
	r := waitChan(t, got, "Archive")
	if r.err != nil {
		t.Fatalf("Archive = %v", r.err)
	}
	if r.t.ArchivedAt.IsZero() {
		t.Errorf("parent %+v", r.t)
	}
}

// waitInStack waits for a goroutine to be inside fn: a gate on where another call has got
// to, for code with nothing else to watch.
func waitInStack(t *testing.T, fn string) {
	t.Helper()
	buf := make([]byte, 8<<20)
	deadline := time.Now().Add(5 * time.Second)
	for time.Now().Before(deadline) {
		if n := runtime.Stack(buf, true); bytes.Contains(buf[:n], []byte(fn)) {
			return
		}
		time.Sleep(time.Millisecond)
	}
	t.Fatalf("nothing got to %s", fn)
}

// flagsOf follows item id's Queued flag through the bus until stop is closed.
func flagsOf(sub *bus.Subscription[ThreadEvent], id string, stop <-chan struct{}) <-chan []bool {
	out := make(chan []bool, 1)
	go func() {
		var flags []bool
		for {
			select {
			case ev := <-sub.C():
				if u, ok := ev.(ItemUpdated); ok && u.Item.ID == id {
					flags = append(flags, u.Item.Queued)
				}
			case <-stop:
				out <- flags
				return
			}
		}
	}()
	return out
}

func (t *threadLog) takenAndHandled() (int64, int64) {
	t.mu.Lock()
	defer t.mu.Unlock()
	return t.taken, t.handled
}

// A message behind a setup whose start fails stays queued, in the log and on disk, and
// no turn counts it read: only Claude taking it does that. Try again sends it.
func TestQueuedThroughAFailedStart(t *testing.T) {
	e, rr := newWorktreeEnv(t, nil, func(o *Options) { o.Claude = "/nonexistent/claude" })
	s, release := inSetup(t, e, rr, CreateOptions{InitialPrompt: "first"})
	q, err := e.m.Send(e.ctx(), s.ID, Message{Text: "second"})
	if err != nil {
		t.Fatal(err)
	}
	sub := bus.Subscribe[ThreadEvent](e.bus, 1024)
	defer sub.Close()
	stop := make(chan struct{})
	flags := flagsOf(sub, q.ID, stop)
	release()
	e.waitFor(s.ID, "the start to fail", func(s Thread) bool { return s.Setup.Phase == SetupFailed })
	log := e.m.mustLog(t, s.ID)
	if it, _ := log.get(q.ID); !it.Queued {
		t.Errorf("not queued after the failure: %+v", it)
	}
	if rows, err := loadItems(e.ctx(), e.m.opts.DB, s.ID); err != nil || !slices.ContainsFunc(rows, func(it Item) bool { return it.ID == q.ID && it.Queued }) {
		t.Errorf("not queued on disk: %v", err)
	}
	if taken, handled := log.takenAndHandled(); taken >= q.Ordinal || handled >= q.Ordinal {
		t.Errorf("taken %d, handled %d, message %d: a turn counts it read", taken, handled, q.Ordinal)
	}
	if got, _ := e.m.Get(e.ctx(), s.ID); got.HandledThrough >= q.Ordinal {
		t.Errorf("handled through %d, message %d", got.HandledThrough, q.Ordinal)
	}
	e.m.opts.Claude = fakeClaudeBin
	if _, err := e.m.RetrySetup(e.ctx(), s.ID); err != nil {
		t.Fatal(err)
	}
	e.waitFor(s.ID, "the message to go out", func(s Thread) bool { return s.Setup.Phase == SetupDone && len(s.Setup.Queued) == 0 })
	e.sentUser("second")
	// Claude is working when it arrives, so it is queued there until it reads it.
	close(stop)
	for i, f := range <-flags {
		if !f {
			t.Errorf("update %d cleared the flag", i)
		}
	}
}

// Through a restart too: nothing writes it as read, so the new log counts it right.
func TestQueuedThroughARestart(t *testing.T) {
	e, rr := newWorktreeEnv(t, nil)
	s, _ := inSetup(t, e, rr, CreateOptions{InitialPrompt: "first"})
	q, err := e.m.Send(e.ctx(), s.ID, Message{Text: "second"})
	if err != nil {
		t.Fatal(err)
	}
	e.restart()
	log := e.m.mustLog(t, s.ID)
	if it, _ := log.get(q.ID); !it.Queued {
		t.Errorf("not queued after the restart: %+v", it)
	}
	if taken, handled := log.takenAndHandled(); taken >= q.Ordinal || handled >= q.Ordinal {
		t.Errorf("taken %d, handled %d, message %d", taken, handled, q.Ordinal)
	}
}

// A Claude that dies before its handshake ends what waited for it, the first message too:
// the row lets go, and so does the flag, or it would read as queued for ever.
func TestQueuedEndsWithAProcessThatNeverAnswered(t *testing.T) {
	gate := initGate(t)
	var rr *recordingProjects
	e := newFixtureEnvAt(t, hangFixture(t), []string{"CF_FAKE_CLAUDE_INIT_GATE=" + gate.path}, func(o *Options) {
		rr = &recordingProjects{Fake: o.Projects.(*projecttest.Fake)}
		rr.WorktreeRoot = t.TempDir()
		o.Projects = rr
		o.SlugTimeout = 300 * time.Millisecond
		o.RefExists = func(context.Context, string, string) bool { return false }
	})
	t.Cleanup(gate.open)
	s, release := inSetup(t, e, rr, CreateOptions{InitialPrompt: "first"})
	q, err := e.m.Send(e.ctx(), s.ID, Message{Text: "second"})
	if err != nil {
		t.Fatal(err)
	}
	release()
	e.waitFor(s.ID, "the spawn", func(s Thread) bool { return s.Setup.Phase == SetupDone && s.State == StateStarting })
	if err := syscall.Kill(e.pid(s.ID), syscall.SIGKILL); err != nil {
		t.Fatal(err)
	}
	got := e.waitFor(s.ID, "the process to end", func(s Thread) bool { return s.State == StateDisconnected })
	if len(got.Setup.Queued) != 0 || got.PendingFirst != nil {
		t.Errorf("row: %+v, %+v", got.Setup.Queued, got.PendingFirst)
	}
	if it, _ := e.m.mustLog(t, s.ID).get(q.ID); it.Queued {
		t.Errorf("queued for ever: %+v", it)
	}
}

func TestRetryNewBranchTakenMeanwhile(t *testing.T) {
	t.Run("a generated name in another project", func(t *testing.T) {
		e, flaky, named := flakyEnv(t)
		e.m.opts.RefExists = branchesOfWorktrees(flaky.recordingProjects)
		a := failedOnR2(t, e, flaky)
		first := a.Setup.step(SetupStepName, "").Branch
		flaky.heal()
		// An unrelated thread gets the same name in r2, where A has no branch.
		b := e.create(CreateOptions{ProjectID: "r2", InitialPrompt: "do y", NewWorktree: &NewWorktree{}})
		if b.Branch != first {
			t.Fatalf("B on %q, A named %q", b.Branch, first)
		}
		if _, err := e.m.RetrySetup(e.ctx(), a.ID); err != nil {
			t.Fatal(err)
		}
		done := e.waitFor(a.ID, "the retry to land", func(s Thread) bool { return s.Setup.Phase == SetupDone })
		if done.Branch == first || done.Branch == "" {
			t.Fatalf("A on %q beside B", done.Branch)
		}
		// One thread, one branch: the worktree on the old name went, and every row says so.
		for _, id := range []string{"r1", "r2"} {
			if p, _ := done.CheckoutPath(id); p == "" || p == a.Setup.Made[0].Path || p == b.WorktreePath {
				t.Errorf("%s's checkout %q", id, p)
			}
			if st := done.Setup.step(SetupStepWorktree, id); st.Branch != done.Branch || st.Status != SetupStepDone {
				t.Errorf("step %+v", st)
			}
		}
		if st := done.Setup.step(SetupStepName, ""); st.Branch != done.Branch || st.Status != SetupStepDone {
			t.Errorf("name step %+v", st)
		}
		if countCalls(flaky.Calls, "DeleteMadeBranch r1 "+first) != 1 {
			t.Errorf("calls %q", flaky.Calls)
		}
		if n := named.Load(); n != 2 { // A's and B's: a pick needs no namer
			t.Errorf("namer ran %d times", n)
		}
	})
	t.Run("a typed name is shared, as a first run shares it", func(t *testing.T) {
		e, flaky, _ := flakyEnv(t)
		e.m.opts.RefExists = branchesOfWorktrees(flaky.recordingProjects)
		flaky.fail("r1")
		a, err := e.m.Create(e.ctx(), CreateOptions{ProjectID: "r1", InitialPrompt: "do x", NewWorktree: &NewWorktree{Branch: "fix/typed", BaseRef: "main"}, BackgroundSetup: true})
		if err != nil {
			t.Fatal(err)
		}
		e.waitFor(a.ID, "the setup to fail", func(s Thread) bool { return s.Setup.Phase == SetupFailed })
		flaky.heal()
		b := e.create(CreateOptions{ProjectID: "r1", NewWorktree: &NewWorktree{Branch: "fix/typed"}})
		if _, err := e.m.RetrySetup(e.ctx(), a.ID); err != nil {
			t.Fatal(err)
		}
		done := e.waitFor(a.ID, "the retry to land", func(s Thread) bool { return s.Setup.Phase == SetupDone })
		if done.Branch != "fix/typed" || done.WorktreePath != b.WorktreePath {
			t.Errorf("A on %q at %q, B at %q", done.Branch, done.WorktreePath, b.WorktreePath)
		}
		if !done.Setup.step(SetupStepName, "").Existing {
			t.Errorf("name step %+v", done.Setup.step(SetupStepName, ""))
		}
	})
	t.Run("a generated name another setup has reserved", func(t *testing.T) {
		e, flaky, _ := flakyEnv(t)
		flaky.fail("r1")
		a, err := e.m.Create(e.ctx(), CreateOptions{ProjectID: "r1", InitialPrompt: "do x", NewWorktree: &NewWorktree{}, BackgroundSetup: true})
		if err != nil {
			t.Fatal(err)
		}
		a = e.waitFor(a.ID, "the setup to fail", func(s Thread) bool { return s.Setup.Phase == SetupFailed })
		first := a.Setup.step(SetupStepName, "").Branch
		flaky.heal()
		r, _ := flaky.Snapshot().Project("r1")
		release, ok := e.m.reserveBranch([]string{r.Path}, first)
		if !ok {
			t.Fatal("not free")
		}
		defer release()
		if _, err := e.m.RetrySetup(e.ctx(), a.ID); err != nil {
			t.Fatal(err)
		}
		done := e.waitFor(a.ID, "the retry to land", func(s Thread) bool { return s.Setup.Phase == SetupDone })
		if done.Branch == first {
			t.Errorf("A on the reserved %q", done.Branch)
		}
	})
}

// What the first run saw stands when a retry cannot see it: origin had the branch, and now
// cannot be reached. It is still to be checked out, not made anew from the base.
func TestRetryRemembersTheBranchExisted(t *testing.T) {
	e, flaky, _ := flakyEnv(t)
	var reachable atomic.Bool
	reachable.Store(true)
	e.m.opts.FetchBranch = func(context.Context, string, string) bool { return reachable.Load() }
	flaky.fail("r1")
	s, err := e.m.Create(e.ctx(), CreateOptions{ProjectID: "r1", InitialPrompt: "do x", NewWorktree: &NewWorktree{Branch: "feat/x", BaseRef: "main"}, BackgroundSetup: true})
	if err != nil {
		t.Fatal(err)
	}
	s = e.waitFor(s.ID, "the setup to fail", func(s Thread) bool { return s.Setup.Phase == SetupFailed })
	if !s.Setup.step(SetupStepName, "").Existing {
		t.Fatalf("name step %+v", s.Setup.step(SetupStepName, ""))
	}
	flaky.heal()
	reachable.Store(false)
	if _, err := e.m.RetrySetup(e.ctx(), s.ID); err != nil {
		t.Fatal(err)
	}
	e.waitFor(s.ID, "the retry to land", func(s Thread) bool { return s.Setup.Phase == SetupDone })
	created := flaky.created()
	if len(created) != 1 || created[0].Branch != "feat/x" {
		t.Fatalf("created %+v", created)
	}
	// makeWorktree asks origin for its own look, which fails too: only the base is checked here.
	if got := created[0].BaseRef; got != "" {
		t.Errorf("base %q: the first run dropped it", got)
	}
}

// A branch nobody else has keeps its name, and a retry leaves the reservation free.
func TestRetryKeepsAFreeName(t *testing.T) {
	e, flaky, _ := flakyEnv(t)
	e.m.opts.RefExists = branchesOfWorktrees(flaky.recordingProjects)
	a := failedOnR2(t, e, flaky)
	first := a.Setup.step(SetupStepName, "").Branch
	flaky.heal()
	if _, err := e.m.RetrySetup(e.ctx(), a.ID); err != nil {
		t.Fatal(err)
	}
	done := e.waitFor(a.ID, "the retry to land", func(s Thread) bool { return s.Setup.Phase == SetupDone })
	if done.Branch != first || countCalls(flaky.Calls, "RemoveWorktree") != 0 {
		t.Errorf("on %q, was %q; calls %q", done.Branch, first, flaky.Calls)
	}
	r, _ := flaky.Snapshot().Project("r2")
	release, ok := e.m.reserveBranch([]string{r.Path}, first)
	if !ok {
		t.Fatal("the reservation stayed")
	}
	release()
}

// abandonRefused is a project store that cannot undo an add.
type abandonRefused struct{ *recordingProjects }

func (p abandonRefused) AbandonWorktree(context.Context, project.AbandonWorktreeOptions) error {
	return fmt.Errorf("%w: it stays", project.ErrFailedPrecondition)
}

// An add that could not be undone is reported as kept, and stays on the record for a retry.
func TestAddThatCouldNotBeUndone(t *testing.T) {
	var held *heldProjects
	e, rr := newWorktreeEnv(t, nil, func(o *Options) {
		held = &heldProjects{recordingProjects: o.Projects.(*recordingProjects), holding: "r2"}
		o.Projects = held
	})
	e.addGitProject(t, "r2", "other")
	s, err := e.m.Create(e.ctx(), twoProjects())
	if err != nil {
		t.Fatal(err)
	}
	row := e.waitFor(s.ID, "r1's worktree", func(s Thread) bool { return stepStatus(s, SetupStepWorktree, "r1") == SetupStepDone })
	ctx, cancel := context.WithTimeout(context.Background(), 3*time.Second)
	defer cancel()
	if err := e.m.Shutdown(ctx); err != nil {
		t.Fatal(err)
	}
	half := filepath.Join(t.TempDir(), "half")
	if err := os.MkdirAll(half, 0o755); err != nil {
		t.Fatal(err)
	}
	row.Setup = row.Setup.edit(func(c *Setup) {
		c.Adding = []SetupAdd{{ProjectID: "r2", Path: half, Branch: "b", Head: "abc"}}
	})
	if err := saveThread(ctx, e.m.opts.DB, row); err != nil {
		t.Fatal(err)
	}
	e.open(func(o *Options) { o.Projects = abandonRefused{rr} })
	d, err := e.m.DiscardSetup(e.ctx(), s.ID)
	if err != nil {
		t.Fatal(err)
	}
	if !slices.Contains(d.Kept, half) {
		t.Errorf("kept %q", d.Kept)
	}
}

// A branch another thread is on stays, even when a lost add made it: only the worktree's
// remains go, as in a rollback.
func TestAbandonAddKeepsABranchAThreadHolds(t *testing.T) {
	e, flaky, _ := flakyEnv(t)
	b := e.create(CreateOptions{ProjectID: "r1", NewWorktree: &NewWorktree{Branch: "fix/held"}})
	if b.Branch != "fix/held" {
		t.Fatalf("B on %q", b.Branch)
	}
	s := Thread{ID: "s-a", Setup: &Setup{Adding: []SetupAdd{{ProjectID: "r1", Path: filepath.Join(t.TempDir(), "half"), Branch: "fix/held", Head: "abc"}}}}
	e.m.abandonAdds(e.ctx(), s)
	if len(flaky.Abandons) != 1 || flaky.Abandons[0].Head != "" {
		t.Errorf("abandons %+v", flaky.Abandons)
	}
}

// A cancel does not wait behind another add on the same branch.
func TestCancelDoesNotWaitForTheWorktreeLock(t *testing.T) {
	e, rr := newWorktreeEnv(t, nil)
	unlock, err := e.m.lockWorktree(e.ctx(), "r1", "fix/held")
	if err != nil {
		t.Fatal(err)
	}
	defer unlock()
	s, err := e.m.Create(e.ctx(), CreateOptions{ProjectID: "r1", InitialPrompt: "do x", NewWorktree: &NewWorktree{Branch: "fix/held"}, BackgroundSetup: true})
	if err != nil {
		t.Fatal(err)
	}
	waitInStack(t, "(*Manager).lockWorktree")
	ctx, cancel := context.WithTimeout(context.Background(), 3*time.Second)
	defer cancel()
	got, _, err := e.m.CancelSetup(ctx, s.ID)
	if err != nil || got.Setup.Phase != SetupCancelled {
		t.Fatalf("CancelSetup = %+v, %v", got.Setup, err)
	}
	if n := worktreeCount(rr, "r1"); n != 1 {
		t.Errorf("r1 has %d worktrees", n)
	}
}

func TestCreateWithOptionsFromARequest(t *testing.T) {
	s := Thread{Model: "m", Effort: "high", PermissionMode: PermissionAuto, CreatedBy: "s-1", Brief: "b", Labels: []string{"l"},
		BudgetUSD: 2, SpawnEnv: []string{"A=1"}, SpawnAddDirs: []string{"/x"}, SystemPromptAppend: "sys"}
	r := setupRequestOf(CreateOptions{ProjectID: "r1", ProjectIDs: []string{"r1"}, Like: "s-2", NewWorktree: &NewWorktree{Branch: "b"},
		Name: "n", InitialPrompt: "p", ComposerPrompt: "c", Attachments: []string{"/a"}, Notify: true, DraftJSON: "{}"})
	o := r.options(s)
	if o.ProjectID != "r1" || o.Like != "s-2" || o.NewWorktree.Branch != "b" || o.Name != "n" || o.InitialPrompt != "p" ||
		o.ComposerPrompt != "c" || !o.Notify || o.DraftJSON != "{}" || !o.BackgroundSetup {
		t.Errorf("from the request: %+v", o)
	}
	if o.Model != "m" || o.Effort != "high" || o.PermissionMode != PermissionAuto || o.CreatedBy != "s-1" || o.Brief != "b" || o.BudgetUSD != 2 ||
		o.SystemPromptAppend != "sys" || !slices.Equal(o.Env, s.SpawnEnv) || !slices.Equal(o.AddDirs, s.SpawnAddDirs) {
		t.Errorf("from the row: %+v", o)
	}
}
