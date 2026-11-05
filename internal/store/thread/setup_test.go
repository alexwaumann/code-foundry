package thread

import (
	"context"
	"errors"
	"fmt"
	"slices"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/alexwaumann/code-foundry/internal/bus"
	"github.com/alexwaumann/code-foundry/internal/store/project"
)

// gateFetches makes every fetch wait until release is called (or its ctx ends), and
// reports each start on the channel.
func gateFetches(rr *recordingProjects) (started <-chan string, release func()) {
	ch := make(chan string, 16)
	gate := make(chan struct{})
	var once sync.Once
	rr.OnFetch = func(ctx context.Context, o project.CreateWorktreeOptions) error {
		ch <- o.ProjectID
		select {
		case <-gate:
			return nil
		case <-ctx.Done():
			return ctx.Err()
		}
	}
	return ch, func() { once.Do(func() { close(gate) }) }
}

// waitChan waits for one value on ch.
func waitChan[T any](t *testing.T, ch <-chan T, what string) T {
	t.Helper()
	select {
	case v := <-ch:
		return v
	case <-time.After(5 * time.Second):
		t.Fatalf("timed out waiting for %s", what)
		panic("unreachable")
	}
}

// inSetup starts a background setup held at its fetch: the thread as Create returned it,
// and what lets the fetch go.
func inSetup(t *testing.T, e *env, rr *recordingProjects, o CreateOptions) (Thread, func()) {
	t.Helper()
	started, release := gateFetches(rr)
	t.Cleanup(release)
	o.BackgroundSetup = true
	if o.NewWorktree == nil && !o.NewBranch {
		o.NewWorktree = &NewWorktree{}
	}
	if o.ProjectID == "" && len(o.ProjectIDs) == 0 {
		o.ProjectID = "r1"
	}
	s, err := e.m.Create(e.ctx(), o)
	if err != nil {
		t.Fatal(err)
	}
	waitChan(t, started, "the fetch to start")
	return s, release
}

// failedSetup is a background setup whose worktree failed.
func failedSetup(t *testing.T, e *env, rr *recordingProjects) Thread {
	t.Helper()
	rr.mu.Lock()
	rr.err = errors.New("git says no")
	rr.mu.Unlock()
	s, err := e.m.Create(e.ctx(), CreateOptions{ProjectID: "r1", InitialPrompt: "do x", NewWorktree: &NewWorktree{}, BackgroundSetup: true})
	if err != nil {
		t.Fatal(err)
	}
	return e.waitFor(s.ID, "the setup to fail", func(s Thread) bool { return s.Setup.Phase == SetupFailed })
}

func stepStatus(s Thread, kind SetupStepKind, projectID string) SetupStepStatus {
	st := s.Setup.step(kind, projectID)
	if st == nil {
		return SetupStepStatusUnspecified
	}
	return st.Status
}

func TestSetupBackgroundReturnsBeforeSlowFetch(t *testing.T) {
	e, rr := newWorktreeEnv(t, nil)
	s, release := inSetup(t, e, rr, CreateOptions{InitialPrompt: "fix the login page"})

	// As Create returned it: visible, working, its message in the timeline, nothing placed.
	if s.State != StateStarting || s.Status != StatusBusy || s.StatusReason != ReasonSettingUp {
		t.Errorf("state %v status %v %q", s.State, s.Status, s.StatusReason)
	}
	if s.WorktreePath != "" || s.Branch != "" || s.CreatedWorktree || s.ProjectID != "r1" {
		t.Errorf("placement of a thread in setup: %+v", s)
	}
	if s.Name == "" || !s.NameProvisional {
		t.Errorf("name %q provisional %v", s.Name, s.NameProvisional)
	}
	if !s.SettingUp() {
		t.Fatalf("setup = %+v", s.Setup)
	}
	got, _ := e.m.Snapshot().Thread(s.ID)
	if got.ID != s.ID {
		t.Fatal("the thread is not in the snapshot")
	}
	items := e.items(s.ID).Items
	i := slices.IndexFunc(items, func(it Item) bool { return it.Kind == KindUserMessage && it.Text == "fix the login page" })
	if i < 0 {
		t.Fatalf("no user message yet:\n%s", describeItems(items))
	}
	if got.PendingFirst == nil || got.PendingFirst.ItemID != items[i].ID {
		t.Errorf("pending first = %+v, item %s", got.PendingFirst, items[i].ID)
	}
	if rows, err := loadThreads(e.ctx(), e.m.opts.DB); err != nil || !slices.ContainsFunc(rows, func(r Thread) bool { return r.ID == s.ID }) {
		t.Errorf("no row yet: %v", err)
	}

	release()
	done := e.waitFor(s.ID, "the setup to end", func(s Thread) bool { return s.Setup.Phase == SetupDone })
	if done.WorktreePath == "" || !done.CreatedWorktree || done.Branch == "" {
		t.Errorf("after setup: %+v", done)
	}
	if done.Setup.Request != nil || done.Setup.Made != nil {
		t.Errorf("a finished setup keeps %+v, %+v", done.Setup.Request, done.Setup.Made)
	}
	e.waitUserText("fix the login page")
	// One message: the item written first goes out under its id.
	items = e.waitItems(s.ID, "the answer", func(items []Item) bool {
		return slices.ContainsFunc(items, func(it Item) bool { return it.Kind == KindAssistantText })
	})
	n := 0
	for _, it := range items {
		if it.Kind == KindUserMessage {
			n++
		}
	}
	if n != 1 {
		t.Errorf("%d user messages:\n%s", n, describeItems(items))
	}
}

func TestSetupStepsChangeAsTheyHappen(t *testing.T) {
	e, rr := newWorktreeEnv(t, nil)
	e.namer = func(string) (string, error) { return "Title: Fix login\nBranch: fix/login", nil }
	sub := bus.Subscribe[Event](e.bus, 256)
	defer sub.Close()
	s, release := inSetup(t, e, rr, CreateOptions{InitialPrompt: "fix the login page"})
	running := e.waitFor(s.ID, "the fetch to show", func(s Thread) bool { return stepStatus(s, SetupStepFetch, "r1") == SetupStepRunning })
	if got := stepStatus(running, SetupStepStart, ""); got != SetupStepPending {
		t.Errorf("start step = %v while fetching", got)
	}
	e.waitFor(s.ID, "the branch named during the fetch", func(s Thread) bool {
		return stepStatus(s, SetupStepName, "") == SetupStepDone && stepStatus(s, SetupStepFetch, "r1") == SetupStepRunning &&
			s.Name == "Fix login" && !s.NameProvisional
	})
	release()
	done := e.waitFor(s.ID, "the setup to end", func(s Thread) bool { return s.Setup.Phase == SetupDone })

	var kinds []SetupStepKind
	for _, st := range done.Setup.Steps {
		kinds = append(kinds, st.Kind)
		if st.Status != SetupStepDone || st.StartedAt.IsZero() || st.EndedAt.Before(st.StartedAt) {
			t.Errorf("step %+v", st)
		}
	}
	if want := []SetupStepKind{SetupStepName, SetupStepFetch, SetupStepWorktree, SetupStepStart}; !slices.Equal(kinds, want) {
		t.Errorf("steps %v, want %v", kinds, want)
	}
	if w := done.Setup.step(SetupStepWorktree, "r1"); w.Branch != "fix/login" || w.ProjectName != "repo" {
		t.Errorf("worktree step %+v", w)
	}
	if n := done.Setup.step(SetupStepName, ""); n.Branch != "fix/login" {
		t.Errorf("name step %+v", n)
	}
	if f := done.Setup.step(SetupStepFetch, "r1"); f.Ref != "origin/main" {
		t.Errorf("fetch step %+v", f)
	}
	if done.Setup.EndedAt.IsZero() || done.Setup.StartedAt.IsZero() {
		t.Errorf("setup %+v", done.Setup)
	}

	// Every status a step went through was published, in order.
	var seen []SetupStepStatus
	for len(seen) == 0 || seen[len(seen)-1] != SetupStepDone {
		ev := waitChan(t, sub.C(), "the published steps")
		if u, ok := ev.(Updated); ok && u.Thread.ID == s.ID && u.Thread.Setup != nil {
			if st := stepStatus(u.Thread, SetupStepFetch, "r1"); len(seen) == 0 || seen[len(seen)-1] != st {
				seen = append(seen, st)
			}
		}
	}
	if want := []SetupStepStatus{SetupStepPending, SetupStepRunning, SetupStepDone}; !slices.Equal(seen, want) {
		t.Errorf("fetch step went %v, want %v", seen, want)
	}
}

// The namer and the fetch of a new branch's base run side by side: each waits to see the
// other start.
func TestSetupNamerAndFetchRunInParallel(t *testing.T) {
	for _, background := range []bool{false, true} {
		t.Run(map[bool]string{false: "waited for", true: "background"}[background], func(t *testing.T) {
			e, rr := newWorktreeEnv(t, nil, func(o *Options) { o.SlugTimeout = 5 * time.Second })
			naming, fetching := make(chan struct{}), make(chan struct{})
			rr.OnFetch = func(ctx context.Context, _ project.CreateWorktreeOptions) error {
				close(fetching)
				select {
				case <-naming:
					return nil
				case <-time.After(3 * time.Second):
					return errors.New("the namer never started")
				}
			}
			e.namer = func(string) (string, error) {
				close(naming)
				select {
				case <-fetching:
					return "Title: Do x\nBranch: fix/do-x", nil
				case <-time.After(3 * time.Second):
					return "", errors.New("the fetch never started")
				}
			}
			s, err := e.m.Create(e.ctx(), CreateOptions{ProjectID: "r1", InitialPrompt: "do x", NewWorktree: &NewWorktree{}, BackgroundSetup: background})
			if err != nil {
				t.Fatal(err)
			}
			done := e.waitFor(s.ID, "the setup to end", func(s Thread) bool { return s.Setup.Phase == SetupDone })
			if done.Branch != "fix/do-x" || stepStatus(done, SetupStepFetch, "r1") != SetupStepDone {
				t.Errorf("branch %q, setup %+v", done.Branch, done.Setup)
			}
			// Fetched once, ahead of CreateWorktree.
			if got := rr.created(); len(got) != 1 || got[0].Fetch {
				t.Errorf("CreateWorktree calls %+v", got)
			}
			if len(rr.Fetches) != 1 {
				t.Errorf("fetches %+v", rr.Fetches)
			}
		})
	}
}

func TestSetupFetches(t *testing.T) {
	no := false
	tests := []struct {
		name string
		nw   *NewWorktree
		// refs exist in the repository.
		refs      []string
		wantFetch int // fetches, ahead of CreateWorktree or in it
		wantStep  bool
		wantInCW  bool // CreateWorktree fetches itself (Options.Fetch)
	}{
		{name: "a new branch's base is fetched ahead", nw: &NewWorktree{}, wantFetch: 1, wantStep: true},
		{name: "off fetches nothing", nw: &NewWorktree{BaseFromOrigin: &no}, wantInCW: true},
		{name: "an existing branch keeps its fetch in CreateWorktree", nw: &NewWorktree{Branch: "feat/existing"},
			refs: []string{"refs/heads/feat/existing"}, wantFetch: 1, wantStep: true, wantInCW: true},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			e, rr := newWorktreeEnv(t, tt.refs)
			s, err := e.m.Create(e.ctx(), CreateOptions{ProjectID: "r1", InitialPrompt: "do x", NewWorktree: tt.nw})
			if err != nil {
				t.Fatal(err)
			}
			if got := len(rr.Fetches); got != tt.wantFetch {
				t.Errorf("fetches %+v", rr.Fetches)
			}
			if got := rr.created(); len(got) != 1 || got[0].Fetch != tt.wantInCW {
				t.Errorf("CreateWorktree calls %+v", got)
			}
			if got := s.Setup.step(SetupStepFetch, "r1") != nil; got != tt.wantStep {
				t.Errorf("fetch step listed %v; steps %+v", got, s.Setup.Steps)
			}
		})
	}
}

func TestSetupFetchFailureIsAWarning(t *testing.T) {
	at := time.Now().Add(-2 * time.Hour).Truncate(time.Second)
	e, rr := newWorktreeEnv(t, nil)
	rr.OnFetch = func(context.Context, project.CreateWorktreeOptions) error {
		return &project.GitError{Stderr: "fatal: unable to access origin\n", ExitCode: 128}
	}
	rr.FetchRefAt = at
	s, err := e.m.Create(e.ctx(), CreateOptions{ProjectID: "r1", InitialPrompt: "do x", NewWorktree: &NewWorktree{}})
	if err != nil {
		t.Fatal(err)
	}
	if s.Setup.Phase != SetupDone || s.WorktreePath == "" {
		t.Fatalf("a failed fetch stopped the setup: %+v", s.Setup)
	}
	f := s.Setup.step(SetupStepFetch, "r1")
	if f.Status != SetupStepWarning || f.Warning != "Could not reach origin" || f.Error != "fatal: unable to access origin" ||
		!f.RefAt.Equal(at) || f.EndedAt.IsZero() {
		t.Errorf("fetch step %+v", f)
	}
}

func TestSetupWaitedForFailureLeavesNoThread(t *testing.T) {
	e, rr := newWorktreeEnv(t, nil)
	rr.err = &project.GitError{Stderr: "fatal: no room", ExitCode: 128}
	sub := bus.Subscribe[Event](e.bus, 256)
	defer sub.Close()
	before := len(e.m.Snapshot().Threads)
	_, err := e.m.Create(e.ctx(), CreateOptions{ProjectID: "r1", InitialPrompt: "do x", NewWorktree: &NewWorktree{}})
	if err == nil || !errors.Is(err, ErrFailedPrecondition) || !strings.Contains(err.Error(), "create worktree") {
		t.Fatalf("Create = %v", err)
	}
	if got := e.m.Snapshot().Threads; len(got) != before {
		t.Errorf("threads left: %+v", got)
	}
	rows, lerr := loadThreads(e.ctx(), e.m.opts.DB)
	if lerr != nil || len(rows) != before {
		t.Errorf("rows left: %d (%v)", len(rows), lerr)
	}
	// A client that saw the thread for a moment is told it is gone.
	var id string
	for id == "" {
		switch ev := waitChan(t, sub.C(), "the removal").(type) {
		case Updated:
		case Removed:
			id = ev.ID
		}
	}
	if _, ok := e.m.Removed(id); ok {
		t.Errorf("a thread that never was left a tombstone")
	}
}

// A start that fails after the worktree was made takes the worktree with it.
func TestSetupWaitedForSpawnFailureRollsBack(t *testing.T) {
	e, rr := newWorktreeEnv(t, nil, func(o *Options) { o.Claude = "/nonexistent/claude" })
	_, err := e.m.Create(e.ctx(), CreateOptions{ProjectID: "r1", InitialPrompt: "do x", NewWorktree: &NewWorktree{}})
	if err == nil {
		t.Fatal("Create with no claude succeeded")
	}
	if len(e.m.Snapshot().Threads) != 0 {
		t.Errorf("threads left: %+v", e.m.Snapshot().Threads)
	}
	removed := slices.ContainsFunc(rr.Calls, func(c string) bool { return strings.HasPrefix(c, "RemoveWorktree") })
	if !removed {
		t.Errorf("no rollback; calls %q", rr.Calls)
	}
}

func TestSetupWaitedForCancelBehavesAsBefore(t *testing.T) {
	e, rr := newWorktreeEnv(t, nil)
	started, release := gateFetches(rr)
	defer release()
	e.namer = func(string) (string, error) {
		time.Sleep(50 * time.Millisecond)
		return "Title: T\nBranch: fix/t", nil
	}
	ctx, cancel := context.WithCancel(context.Background())
	errc := make(chan error, 1)
	go func() {
		_, err := e.m.Create(ctx, CreateOptions{ProjectID: "r1", InitialPrompt: "do x", NewWorktree: &NewWorktree{}})
		errc <- err
	}()
	waitChan(t, started, "the fetch")
	cancel()
	if err := waitChan(t, errc, "Create to end"); !errors.Is(err, context.Canceled) {
		t.Fatalf("Create = %v", err)
	}
	if got := e.m.Snapshot().Threads; len(got) != 0 {
		t.Errorf("threads left: %+v", got)
	}
}

func TestSetupBackgroundFailureStaysOnTheThread(t *testing.T) {
	e, rr := newWorktreeEnv(t, nil)
	s := failedSetup(t, e, rr)
	if s.State != StateDisconnected || s.Status != StatusError || s.StatusReason != ReasonSetupFailed || s.DisconnectReason != ReasonSetupFailed {
		t.Errorf("state %v status %v %q, disconnect %q", s.State, s.Status, s.StatusReason, s.DisconnectReason)
	}
	if !strings.Contains(s.LastError, "git says no") || !strings.Contains(s.Setup.Error, "git says no") {
		t.Errorf("last error %q, setup %q", s.LastError, s.Setup.Error)
	}
	w := s.Setup.step(SetupStepWorktree, "r1")
	if w.Status != SetupStepFailed || w.Error != "git says no" {
		t.Errorf("worktree step %+v", w)
	}
	if got := stepStatus(s, SetupStepStart, ""); got != SetupStepPending {
		t.Errorf("start step %v", got)
	}
	if s.Setup.Request == nil || s.PendingFirst == nil {
		t.Errorf("what a retry needs went: %+v, %+v", s.Setup.Request, s.PendingFirst)
	}
	if !Meets(CondSettled, s) || !Meets(CondError, s) {
		t.Errorf("a failed setup does not settle: %+v", s)
	}
	// The message's turn ended, so nothing reads as running and a wait counts it.
	items := e.items(s.ID).Items
	if !slices.ContainsFunc(items, func(it Item) bool { return it.Kind == KindTurnEnd }) {
		t.Errorf("no turn end:\n%s", describeItems(items))
	}
}

func TestSetupWorkingWhileItRuns(t *testing.T) {
	e, rr := newWorktreeEnv(t, nil)
	s, _ := inSetup(t, e, rr, CreateOptions{InitialPrompt: "do x"})
	for _, c := range []Condition{CondSettled, CondIdle, CondAttention, CondError, CondDisconnected} {
		if Meets(c, s) {
			t.Errorf("a thread in setup meets %v", c)
		}
	}
}

func TestSetupTable(t *testing.T) {
	at := time.Now()
	tests := []struct {
		name  string
		steps []SetupStep
		want  []SetupStepStatus
	}{
		{"a running step takes the failure", []SetupStep{{Kind: SetupStepName, Status: SetupStepDone}, {Kind: SetupStepWorktree, Status: SetupStepRunning}, {Kind: SetupStepStart, Status: SetupStepPending}},
			[]SetupStepStatus{SetupStepDone, SetupStepFailed, SetupStepPending}},
		{"a step that failed keeps it", []SetupStep{{Kind: SetupStepWorktree, Status: SetupStepFailed, Error: "own"}, {Kind: SetupStepStart, Status: SetupStepPending}},
			[]SetupStepStatus{SetupStepFailed, SetupStepPending}},
		{"nothing begun: the first pending one takes it", []SetupStep{{Kind: SetupStepWorktree, Status: SetupStepPending}, {Kind: SetupStepStart, Status: SetupStepPending}},
			[]SetupStepStatus{SetupStepFailed, SetupStepPending}},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			s := &Setup{Phase: SetupRunning, Steps: tt.steps}
			was := slices.Clone(s.Steps)
			got := s.failed(at, "why")
			if got.Phase != SetupFailed || got.Error != "why" || !got.EndedAt.Equal(at) {
				t.Errorf("setup %+v", got)
			}
			for i, st := range got.Steps {
				if st.Status != tt.want[i] {
					t.Errorf("step %d: %v, want %v", i, st.Status, tt.want[i])
				}
			}
			if !slices.Equal(s.Steps, was) || s.Phase != SetupRunning {
				t.Errorf("failed changed the setup it was given")
			}
		})
	}
}

func TestParseSetup(t *testing.T) {
	draft := `{"text":"hi"}`
	s := &Setup{Phase: SetupFailed, StartedAt: time.UnixMilli(1000), Steps: []SetupStep{{Kind: SetupStepFetch, ProjectID: "r1", Status: SetupStepWarning}},
		Made: []SetupWorktree{{ProjectID: "r1", Path: "/w", Branch: "b", NewBranch: true}}, Request: &SetupRequest{ProjectID: "r1", DraftJSON: draft}}
	tests := []struct {
		name string
		col  string
		nil_ bool
	}{
		{"a row from before the column", "", true},
		{"malformed", "{", true},
		{"round trip", setupJSON(s), false},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			got := parseSetup(tt.col)
			if (got == nil) != tt.nil_ {
				t.Fatalf("parseSetup = %+v", got)
			}
			if got != nil && (got.Request.DraftJSON != draft || len(got.Made) != 1 || !got.StartedAt.Equal(s.StartedAt) || got.Steps[0].Status != SetupStepWarning) {
				t.Errorf("parseSetup = %+v", got)
			}
		})
	}
	if setupJSON(nil) != "" {
		t.Error("no setup is not empty")
	}
}

// A thread with nothing to make still has its one start step; forks and residents have
// no setup, and a row from before the column loads without one.
func TestSetupWhoHasOne(t *testing.T) {
	e := newEnv(t)
	s := e.create(CreateOptions{InitialPrompt: "go"})
	if s.Setup == nil || s.Setup.Phase != SetupDone || len(s.Setup.Steps) != 1 || s.Setup.Steps[0].Kind != SetupStepStart || s.Setup.Steps[0].Status != SetupStepDone {
		t.Fatalf("setup = %+v", s.Setup)
	}
	r, _, err := e.m.EnsureResident(e.ctx(), "ember", ResidentOptions{Cwd: e.home})
	if err != nil {
		t.Fatal(err)
	}
	if r.Setup != nil {
		t.Errorf("a resident has a setup: %+v", r.Setup)
	}
	if err := e.m.Shutdown(e.ctx()); err != nil {
		t.Fatal(err)
	}
	if _, err := e.m.opts.DB.ExecContext(e.ctx(), `UPDATE threads SET setup = '' WHERE id = ?`, s.ID); err != nil {
		t.Fatal(err)
	}
	e.open()
	if got, _ := e.m.Get(e.ctx(), s.ID); got.Setup != nil {
		t.Errorf("an old row has a setup: %+v", got.Setup)
	}
}

func TestSetupSurvivesAReload(t *testing.T) {
	e := newEnv(t)
	s := e.create(CreateOptions{InitialPrompt: "go"})
	e.restart()
	got, _ := e.m.Get(e.ctx(), s.ID)
	if got.Setup == nil || got.Setup.Phase != SetupDone || got.Setup.EndedAt.IsZero() {
		t.Errorf("setup = %+v", got.Setup)
	}
}

func TestSetupRestartFailsAThreadInSetup(t *testing.T) {
	e, rr := newWorktreeEnv(t, nil)
	s, _ := inSetup(t, e, rr, CreateOptions{InitialPrompt: "do x", DraftJSON: `{"d":1}`})
	e.restart()
	got, err := e.m.Get(e.ctx(), s.ID)
	if err != nil {
		t.Fatal(err)
	}
	if got.State != StateDisconnected || got.Status != StatusError || got.StatusReason != ReasonSetupFailed {
		t.Errorf("state %v status %v %q", got.State, got.Status, got.StatusReason)
	}
	if got.Setup.Phase != SetupFailed || got.Setup.Error != SetupRestarted || got.LastError != SetupRestarted {
		t.Errorf("setup %+v, last error %q", got.Setup, got.LastError)
	}
	// What a retry needs came through.
	req := got.Setup.Request
	if req == nil || req.InitialPrompt != "do x" || req.ProjectID != "r1" || req.NewWorktree == nil || req.DraftJSON != `{"d":1}` {
		t.Errorf("request %+v", req)
	}
	if got.PendingFirst == nil {
		t.Error("the first message went")
	}
	if !slices.ContainsFunc(e.items(s.ID).Items, func(it Item) bool { return it.Kind == KindTurnEnd }) {
		t.Errorf("its turn stayed open:\n%s", describeItems(e.items(s.ID).Items))
	}
	if _, err := e.m.Send(e.ctx(), s.ID, Message{Text: "hello"}); !errors.Is(err, ErrFailedPrecondition) {
		t.Errorf("Send = %v", err)
	}
	// Once more: it stays failed, with nothing new.
	e.restart()
	again, _ := e.m.Get(e.ctx(), s.ID)
	if !again.Setup.EndedAt.Equal(got.Setup.EndedAt) {
		t.Errorf("failed again at %v, was %v", again.Setup.EndedAt, got.Setup.EndedAt)
	}
}

// What a setup made before the daemon went is on the row for the next run to clean up.
func TestSetupRecordsWhatItMade(t *testing.T) {
	var picky *pickyProjects
	e, _ := newWorktreeEnv(t, nil, func(o *Options) {
		picky = &pickyProjects{recordingProjects: o.Projects.(*recordingProjects), failing: "r2"}
		o.Projects = picky
	})
	e.addGitProject(t, "r2", "other")
	s, err := e.m.Create(e.ctx(), CreateOptions{ProjectIDs: []string{"r1", "r2"}, InitialPrompt: "do x", NewWorktree: &NewWorktree{}, BackgroundSetup: true})
	if err != nil {
		t.Fatal(err)
	}
	got := e.waitFor(s.ID, "the setup to fail", func(s Thread) bool { return s.Setup.Phase == SetupFailed })
	if len(got.Setup.Made) != 1 || got.Setup.Made[0].ProjectID != "r1" || !got.Setup.Made[0].NewBranch || got.Setup.Made[0].Path == "" {
		t.Fatalf("made %+v", got.Setup.Made)
	}
	if slices.ContainsFunc(picky.Calls, func(c string) bool { return strings.HasPrefix(c, "RemoveWorktree") }) {
		t.Errorf("a failed background setup removed its worktrees: %q", picky.Calls)
	}
	if st := got.Setup.step(SetupStepWorktree, "r1"); st.Status != SetupStepDone {
		t.Errorf("r1 step %+v", st)
	}
	if st := got.Setup.step(SetupStepWorktree, "r2"); st.Status != SetupStepFailed || st.Error != "fatal: other refuses" {
		t.Errorf("r2 step %+v", st)
	}
	e.restart()
	again, _ := e.m.Get(e.ctx(), s.ID)
	if len(again.Setup.Made) != 1 || again.Setup.Made[0].Path != got.Setup.Made[0].Path {
		t.Errorf("after a restart: %+v", again.Setup.Made)
	}
}

// pickyProjects fails one project's worktree with git's text.
type pickyProjects struct {
	*recordingProjects
	failing string
}

func (p *pickyProjects) CreateWorktree(ctx context.Context, o project.CreateWorktreeOptions) (project.Worktree, error) {
	if o.ProjectID == p.failing {
		return project.Worktree{}, &project.GitError{Stderr: "fatal: other refuses\n", ExitCode: 128}
	}
	return p.recordingProjects.CreateWorktree(ctx, o)
}

func (e *env) addGitProject(t *testing.T, id, name string) {
	t.Helper()
	dir := t.TempDir()
	e.projects.Put(project.Project{ID: id, Path: dir, Name: name, Git: true, Worktrees: []project.Worktree{{ProjectID: id, Path: dir, IsMain: true}}})
}

func TestSetupMultiProject(t *testing.T) {
	e, rr := newWorktreeEnv(t, nil, func(o *Options) { o.SlugTimeout = 5 * time.Second })
	e.addGitProject(t, "r2", "other")
	var mu sync.Mutex
	var fetched []string
	both := make(chan struct{})
	rr.OnFetch = func(_ context.Context, o project.CreateWorktreeOptions) error {
		mu.Lock()
		defer mu.Unlock()
		fetched = append(fetched, o.ProjectID)
		if len(fetched) == 2 {
			close(both)
		}
		return nil
	}
	s, err := e.m.Create(e.ctx(), CreateOptions{ProjectIDs: []string{"r1", "r2:develop"}, InitialPrompt: "do x", NewWorktree: &NewWorktree{}, BackgroundSetup: true})
	if err != nil {
		t.Fatal(err)
	}
	if s.Setup.step(SetupStepFetch, "r1") == nil || s.Setup.step(SetupStepFetch, "r2") == nil ||
		s.Setup.step(SetupStepWorktree, "r1") == nil || s.Setup.step(SetupStepWorktree, "r2") == nil {
		t.Fatalf("steps %+v", s.Setup.Steps)
	}
	waitChan(t, both, "a fetch per project")
	done := e.waitFor(s.ID, "the setup to end", func(s Thread) bool { return s.Setup.Phase == SetupDone })
	if got := done.Setup.step(SetupStepFetch, "r2"); got.Ref != "origin/develop" || got.ProjectName != "other" {
		t.Errorf("r2's fetch %+v", got)
	}
	if len(done.CheckoutPaths) != 2 || done.CheckoutPaths["r2"] == "" {
		t.Errorf("checkouts %+v", done.CheckoutPaths)
	}
}

func TestSetupFastRefusalsMakeNoThread(t *testing.T) {
	tests := []struct {
		name string
		o    CreateOptions
		want error
	}{
		{"a bad base", CreateOptions{ProjectID: "r1", NewWorktree: &NewWorktree{BaseRef: "-x"}}, ErrInvalidArgument},
		{"a bad branch", CreateOptions{ProjectID: "r1", NewWorktree: &NewWorktree{Branch: "!!!"}}, ErrInvalidArgument},
		{"no project", CreateOptions{}, ErrInvalidArgument},
		{"an unknown project", CreateOptions{ProjectID: "nope"}, ErrNotFound},
		{"an unknown like", CreateOptions{Like: "nope"}, ErrInvalidArgument},
		{"a bad name", CreateOptions{ProjectID: "r1", Name: "a\nb"}, ErrInvalidArgument},
		{"a NUL in the prompt", CreateOptions{ProjectID: "r1", InitialPrompt: "a\x00b"}, ErrInvalidArgument},
		{"a draft too big", CreateOptions{ProjectID: "r1", DraftJSON: strings.Repeat("x", MaxDraftJSON+1)}, ErrInvalidArgument},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			e, _ := newWorktreeEnv(t, nil)
			tt.o.BackgroundSetup = true
			if _, err := e.m.Create(e.ctx(), tt.o); !errors.Is(err, tt.want) {
				t.Fatalf("Create = %v, want %v", err, tt.want)
			}
			if got := e.m.Snapshot().Threads; len(got) != 0 {
				t.Errorf("threads: %+v", got)
			}
		})
	}
}

// refusedWithoutProcess is what a thread with no process and no checkouts refuses.
var refusedWithoutProcess = []struct {
	name string
	call func(e *env, id string) error
}{
	{"send", func(e *env, id string) error {
		_, err := e.m.Send(e.ctx(), id, Message{Text: "hi"})
		return err
	}},
	{"reconnect", func(e *env, id string) error {
		_, err := e.m.Reconnect(e.ctx(), id)
		return err
	}},
	{"fork", func(e *env, id string) error {
		_, err := e.m.Fork(e.ctx(), id, "")
		return err
	}},
	{"run in", func(e *env, id string) error {
		_, err := e.m.RunIn(e.ctx(), id, RunInTarget{ProjectID: "r1"})
		return err
	}},
	{"add project", func(e *env, id string) error {
		_, err := e.m.AddProject(e.ctx(), id, "r2")
		return err
	}},
	{"remove project", func(e *env, id string) error {
		_, err := e.m.RemoveProject(e.ctx(), id, "r2")
		return err
	}},
	{"move", func(e *env, id string) error {
		_, err := e.m.Move(e.ctx(), id, MoveOptions{ProjectID: "r2"})
		return err
	}},
	{"reseed", func(e *env, id string) error {
		_, _, err := e.m.Reseed(e.ctx(), id, ReseedOptions{})
		return err
	}},
	{"like", func(e *env, id string) error {
		_, err := e.m.Create(e.ctx(), CreateOptions{Like: id})
		return err
	}},
}

func TestSetupRefusalsWhileItRuns(t *testing.T) {
	e, rr := newWorktreeEnv(t, nil)
	e.addGitProject(t, "r2", "other")
	s, release := inSetup(t, e, rr, CreateOptions{InitialPrompt: "do x"})
	calls := append(slices.Clone(refusedWithoutProcess), []struct {
		name string
		call func(e *env, id string) error
	}{
		{"snooze", func(e *env, id string) error {
			_, err := e.m.Snooze(e.ctx(), id, time.Now().Add(time.Hour))
			return err
		}},
		{"save for later", func(e *env, id string) error {
			_, err := e.m.SaveForLater(e.ctx(), id)
			return err
		}},
		{"effort", func(e *env, id string) error {
			_, err := e.m.SetEffort(e.ctx(), id, "high")
			return err
		}},
		{"model", func(e *env, id string) error {
			_, err := e.m.SetModel(e.ctx(), id, "claude-sonnet-5-5")
			return err
		}},
		{"permission mode", func(e *env, id string) error {
			_, err := e.m.SetPermissionMode(e.ctx(), id, PermissionAuto)
			return err
		}},
	}...)
	for _, tt := range calls {
		t.Run(tt.name, func(t *testing.T) {
			if err := tt.call(e, s.ID); !errors.Is(err, ErrFailedPrecondition) {
				t.Errorf("= %v, want a failed precondition", err)
			}
		})
	}
	t.Run("what does nothing", func(t *testing.T) {
		if err := e.m.Interrupt(e.ctx(), s.ID, ""); err != nil {
			t.Errorf("Interrupt = %v", err)
		}
		if _, restarted, err := e.m.Restart(e.ctx(), s.ID); err != nil || restarted {
			t.Errorf("Restart = %v %v", restarted, err)
		}
		tc, err := e.m.Checkouts(e.ctx(), CheckoutsRef{ID: s.ID})
		if err != nil || len(tc.Checkouts) != 0 {
			t.Errorf("Checkouts = %+v, %v", tc.Checkouts, err)
		}
		if hints := e.m.CheckoutHints(s); len(hints) != 0 {
			t.Errorf("hints %q", hints)
		}
	})
	t.Run("what needs no process goes on", func(t *testing.T) {
		if _, err := e.m.Rename(e.ctx(), s.ID, "Mine"); err != nil {
			t.Error(err)
		}
		if _, err := e.m.Pin(e.ctx(), s.ID, true); err != nil {
			t.Error(err)
		}
	})
	release()
	done := e.waitFor(s.ID, "the setup to end", func(s Thread) bool { return s.Setup.Phase == SetupDone })
	if done.Name != "Mine" || !done.Pinned {
		t.Errorf("the rename or pin did not last: %+v", done)
	}
}

func TestSetupRefusalsAfterItFailed(t *testing.T) {
	e, rr := newWorktreeEnv(t, nil)
	e.addGitProject(t, "r2", "other")
	s := failedSetup(t, e, rr)
	for _, tt := range refusedWithoutProcess {
		t.Run(tt.name, func(t *testing.T) {
			if err := tt.call(e, s.ID); !errors.Is(err, ErrFailedPrecondition) {
				t.Errorf("= %v, want a failed precondition", err)
			}
		})
	}
	t.Run("what only goes to the row", func(t *testing.T) {
		if _, err := e.m.SetEffort(e.ctx(), s.ID, "high"); err != nil {
			t.Errorf("SetEffort = %v", err)
		}
		if _, err := e.m.Snooze(e.ctx(), s.ID, time.Now().Add(time.Hour)); err != nil {
			t.Errorf("Snooze = %v", err)
		}
	})
	if _, err := e.m.Archive(e.ctx(), s.ID, true); err != nil {
		t.Errorf("Archive = %v", err)
	}
	if err := e.m.Remove(e.ctx(), s.ID); err != nil {
		t.Errorf("Remove = %v", err)
	}
}

func TestSetupRemoveDuringIt(t *testing.T) {
	tests := []struct {
		name       string
		background bool
	}{{"background", true}, {"waited for", false}}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			e, rr := newWorktreeEnv(t, nil)
			started, release := gateFetches(rr)
			defer release()
			errc := make(chan error, 1)
			go func() {
				_, err := e.m.Create(context.Background(), CreateOptions{ProjectID: "r1", InitialPrompt: "do x", NewWorktree: &NewWorktree{}, BackgroundSetup: tt.background})
				errc <- err
			}()
			waitChan(t, started, "the fetch")
			id := ""
			for id == "" {
				if ts := e.m.Snapshot().Threads; len(ts) > 0 {
					id = ts[0].ID
				}
			}
			if err := e.m.Remove(e.ctx(), id); err != nil {
				t.Fatalf("Remove = %v", err)
			}
			if _, ok := e.m.Snapshot().Thread(id); ok {
				t.Error("the thread is still there")
			}
			err := waitChan(t, errc, "Create to end")
			if tt.background && err != nil {
				t.Errorf("Create = %v", err)
			}
			if !tt.background && !errors.Is(err, ErrFailedPrecondition) {
				t.Errorf("Create = %v", err)
			}
			if rows, _ := loadThreads(e.ctx(), e.m.opts.DB); len(rows) != 0 {
				t.Errorf("rows %+v", rows)
			}
		})
	}
}

// A Remove that lands while the worktrees are being made, again and again: nothing writes
// to the record it took, and what was made goes with the thread (run with -race).
func TestSetupRemoveRacesIt(t *testing.T) {
	e, _ := newWorktreeEnv(t, nil)
	e.namer = func(string) (string, error) { return "Title: T\nBranch: fix/t", nil }
	for i := range 20 {
		s, err := e.m.Create(e.ctx(), CreateOptions{ProjectID: "r1", InitialPrompt: "do x", NewWorktree: &NewWorktree{}, BackgroundSetup: true})
		if err != nil {
			t.Fatal(err)
		}
		time.Sleep(time.Duration(i) * 100 * time.Microsecond)
		if err := e.m.Remove(e.ctx(), s.ID); err != nil {
			t.Fatalf("Remove = %v", err)
		}
		if _, ok := e.m.Snapshot().Thread(s.ID); ok {
			t.Fatal("the thread is still there")
		}
	}
}

// A Remove during a setup that made one worktree and is making another takes the one made
// with it: nothing else knows it.
func TestSetupRemoveTakesWhatItMade(t *testing.T) {
	var held *heldProjects
	e, _ := newWorktreeEnv(t, nil, func(o *Options) {
		held = &heldProjects{recordingProjects: o.Projects.(*recordingProjects), holding: "r2"}
		o.Projects = held
	})
	e.addGitProject(t, "r2", "other")
	s, err := e.m.Create(e.ctx(), CreateOptions{ProjectIDs: []string{"r1", "r2"}, InitialPrompt: "do x", NewWorktree: &NewWorktree{}, BackgroundSetup: true})
	if err != nil {
		t.Fatal(err)
	}
	e.waitFor(s.ID, "r1's worktree", func(s Thread) bool { return stepStatus(s, SetupStepWorktree, "r1") == SetupStepDone })
	if err := e.m.Remove(e.ctx(), s.ID); err != nil {
		t.Fatalf("Remove = %v", err)
	}
	if !slices.ContainsFunc(held.Calls, func(c string) bool { return strings.HasPrefix(c, "RemoveWorktree r1") }) {
		t.Errorf("calls %q", held.Calls)
	}
}

// heldProjects holds one project's worktree until its ctx ends.
type heldProjects struct {
	*recordingProjects
	holding string
}

func (p *heldProjects) CreateWorktree(ctx context.Context, o project.CreateWorktreeOptions) (project.Worktree, error) {
	if o.ProjectID == p.holding {
		<-ctx.Done()
		return project.Worktree{}, ctx.Err()
	}
	return p.recordingProjects.CreateWorktree(ctx, o)
}

// failedSpawn is a background setup that made its worktree and could not start Claude.
func failedSpawn(t *testing.T, e *env) Thread {
	t.Helper()
	s, err := e.m.Create(e.ctx(), CreateOptions{ProjectID: "r1", InitialPrompt: "do x", NewWorktree: &NewWorktree{}, BackgroundSetup: true})
	if err != nil {
		t.Fatal(err)
	}
	return e.waitFor(s.ID, "the setup to fail", func(s Thread) bool { return s.Setup.Phase == SetupFailed })
}

func TestSetupSpawnFailureIsTheStartStep(t *testing.T) {
	e, _ := newWorktreeEnv(t, nil, func(o *Options) { o.Claude = "/nonexistent/claude" })
	s := failedSpawn(t, e)
	st := s.Setup.step(SetupStepStart, "")
	if st.Status != SetupStepFailed || st.Error == "" {
		t.Errorf("start step %+v", st)
	}
	if s.WorktreePath == "" || !s.CreatedWorktree {
		t.Errorf("the placement landed before the spawn: %+v", s)
	}
	if strings.HasPrefix(s.LastError, "thread ") {
		t.Errorf("last error %q", s.LastError)
	}
}

func TestSetupArchiveWaitsForIt(t *testing.T) {
	e, rr := newWorktreeEnv(t, nil)
	s, release := inSetup(t, e, rr, CreateOptions{InitialPrompt: "do x"})
	type res struct {
		t   Thread
		err error
	}
	got := make(chan res, 1)
	go func() {
		a, err := e.m.Archive(context.Background(), s.ID, true)
		got <- res{a, err}
	}()
	select {
	case r := <-got:
		t.Fatalf("Archive returned during the setup: %+v %v", r.t, r.err)
	case <-time.After(50 * time.Millisecond):
	}
	release()
	r := waitChan(t, got, "Archive to end")
	if r.err != nil || r.t.ArchivedAt.IsZero() {
		t.Fatalf("Archive = %+v, %v", r.t, r.err)
	}
}

func TestSetupShutdownDuringIt(t *testing.T) {
	e, rr := newWorktreeEnv(t, nil)
	inSetup(t, e, rr, CreateOptions{InitialPrompt: "do x"})
	ctx, cancel := context.WithTimeout(context.Background(), 3*time.Second)
	defer cancel()
	if err := e.m.Shutdown(ctx); err != nil {
		t.Fatalf("Shutdown = %v", err)
	}
}

func TestSetupCreateOnce(t *testing.T) {
	e, rr := newWorktreeEnv(t, nil)
	_, release := gateFetches(rr)
	defer release()
	o := CreateOptions{ProjectID: "r1", InitialPrompt: "do x", NewWorktree: &NewWorktree{}, BackgroundSetup: true}
	first, reused, err := e.m.CreateOnce(e.ctx(), "key", o)
	if err != nil || reused {
		t.Fatalf("CreateOnce = %v %v", reused, err)
	}
	again, reused, err := e.m.CreateOnce(e.ctx(), "key", o)
	if err != nil || !reused || again.ID != first.ID {
		t.Fatalf("repeat = %s %v %v, first %s", again.ID, reused, err, first.ID)
	}
	if n := len(e.m.Snapshot().Threads); n != 1 {
		t.Errorf("%d threads", n)
	}
}

func TestSetupTimelineOrder(t *testing.T) {
	e, rr := newWorktreeEnv(t, nil)
	parent := e.stopped("Lead")
	s, _ := inSetup(t, e, rr, CreateOptions{InitialPrompt: "do x", CreatedBy: parent.ID})
	items := e.items(s.ID).Items
	if len(items) != 2 || items[0].ID != createdByNoteID || items[1].Kind != KindUserMessage || items[1].SentBy != parent.ID {
		t.Fatalf("items:\n%s", describeItems(items))
	}
	// Both are on disk: a restart keeps them.
	e.restart()
	if got := e.items(s.ID).Items; len(got) < 2 || got[0].ID != createdByNoteID {
		t.Errorf("after a restart:\n%s", describeItems(got))
	}
}

func TestSetupBackgroundRewritesRefsOnceThereAreWorktrees(t *testing.T) {
	e, rr := newWorktreeEnv(t, nil)
	s, release := inSetup(t, e, rr, CreateOptions{InitialPrompt: "read cf-file://r1/a.go"})
	if got, _ := e.m.Snapshot().Thread(s.ID); !strings.Contains(got.PendingFirst.Prompt, "cf-file://") {
		t.Errorf("rewritten before the worktree exists: %q", got.PendingFirst.Prompt)
	}
	release()
	done := e.waitFor(s.ID, "the setup to end", func(s Thread) bool { return s.Setup.Phase == SetupDone })
	e.waitUserText("read " + done.WorktreePath + "/a.go")
	if it := e.items(s.ID).Items; !slices.ContainsFunc(it, func(i Item) bool { return i.Text == "read cf-file://r1/a.go" }) {
		t.Errorf("the item changed:\n%s", describeItems(it))
	}
}

func TestSetupWhy(t *testing.T) {
	tests := []struct {
		name string
		err  error
		want string
	}{
		{"a refusal", fmt.Errorf("%w: repo's main checkout is on main", ErrFailedPrecondition), "repo's main checkout is on main"},
		{"a spawn", errors.New("thread s1: spawn claude: not found"), "spawn claude: not found"},
		{"a project's", classified{kind: ErrFailedPrecondition, err: fmt.Errorf("create worktree x in web: %w", fmt.Errorf("%w: fatal: no room", ErrFailedPrecondition))},
			"create worktree x in web: fatal: no room"},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			if got := setupWhy("s1", tt.err); got != tt.want {
				t.Errorf("setupWhy = %q, want %q", got, tt.want)
			}
		})
	}
}
