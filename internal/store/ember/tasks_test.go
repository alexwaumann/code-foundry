package ember

import (
	"context"
	"errors"
	"slices"
	"strings"
	"testing"
	"time"

	"github.com/alexwaumann/code-foundry/internal/store/thread"
)

func TestRolled(t *testing.T) {
	const (
		todo, doing, blocked, done, cancelled = StateTodo, StateDoing, StateBlocked, StateDone, StateCancelled
	)
	tests := []struct {
		name   string
		parent State
		subs   []State
		want   State
		wantOK bool
	}{
		{"no subtasks: as Ember set it", doing, nil, doing, false},
		{"none started", doing, []State{todo, todo}, todo, true},
		{"one doing", todo, []State{doing, todo, todo}, doing, true},
		{"one blocked, one working", todo, []State{blocked, doing}, doing, true},
		{"one blocked, one waiting", todo, []State{blocked, todo}, doing, true},
		{"every open one blocked", doing, []State{blocked, done, blocked}, blocked, true},
		{"one done, the next waiting", todo, []State{done, todo}, doing, true},
		{"one cancelled, the next waiting", todo, []State{cancelled, todo}, todo, true},
		{"all closed: Ember closes it", doing, []State{done, cancelled}, doing, false},
		{"a done parent stays done", done, []State{doing}, done, false},
		{"a cancelled parent stays cancelled", cancelled, []State{doing}, cancelled, false},
		{"blocked again once a piece works", blocked, []State{blocked, doing}, doing, true},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			got, ok := Rolled(tt.parent, tt.subs)
			if got != tt.want || ok != tt.wantOK {
				t.Errorf("Rolled(%s, %v) = %s, %v; want %s, %v", tt.parent, tt.subs, got, ok, tt.want, tt.wantOK)
			}
		})
	}
}

// The parent follows its subtasks on every write: added, updated, blocked by a report.
func TestParentRollup(t *testing.T) {
	t.Parallel()
	e := newEnv(t)
	ctx := context.Background()
	state := func(id string) State {
		t.Helper()
		got, ok := e.s.Snapshot().Task(id)
		if !ok {
			t.Fatalf("no task %s", id)
		}
		return got.State
	}
	set := func(id string, s State) {
		t.Helper()
		e.advance(time.Second)
		if _, err := e.s.UpdateTask(ctx, id, TaskUpdate{State: &s}); err != nil {
			t.Fatal(err)
		}
	}
	parent, err := e.s.AddTask(ctx, NewTask{Title: "Stats dashboard"})
	if err != nil {
		t.Fatal(err)
	}
	var subs []string
	for _, title := range []string{"utilities", "page", "badge"} {
		c, err := e.s.AddTask(ctx, NewTask{Title: title, ParentID: parent.ID})
		if err != nil {
			t.Fatal(err)
		}
		subs = append(subs, c.ID)
	}
	if got := state(parent.ID); got != StateTodo {
		t.Fatalf("planned: parent %s", got)
	}
	set(subs[0], StateDoing)
	if got := state(parent.ID); got != StateDoing {
		t.Errorf("a piece started: parent %s", got)
	}
	if c := e.s.Snapshot().Status.Counts; c.Doing != 2 || c.Todo != 2 {
		t.Errorf("counts = %+v", c)
	}

	// Its worker fails: the piece blocks, so does the parent (no other piece is open but
	// the two waiting).
	worker, err := e.threads.Create(ctx, thread.CreateOptions{Name: "utilities"})
	if err != nil {
		t.Fatal(err)
	}
	if _, err := e.s.UpdateTask(ctx, subs[0], TaskUpdate{ThreadID: &worker.ID}); err != nil {
		t.Fatal(err)
	}
	e.advance(time.Minute)
	if _, err := e.threads.Report(ctx, worker.ID, thread.Report{Status: thread.ReportFailed, Summary: "tests fail"}); err != nil {
		t.Fatal(err)
	}
	e.await("blocked piece", func(s *Snapshot) bool { c, _ := s.Task(subs[0]); return c.State == StateBlocked })
	if got := state(parent.ID); got != StateDoing {
		t.Errorf("one piece blocked, two waiting: parent %s", got)
	}
	set(subs[1], StateCancelled)
	set(subs[2], StateCancelled)
	if got := state(parent.ID); got != StateBlocked {
		t.Errorf("every open piece blocked: parent %s", got)
	}
	set(subs[0], StateDone)
	if got := state(parent.ID); got != StateBlocked {
		t.Errorf("all closed: parent %s, want it left as it was", got)
	}
	set(parent.ID, StateDone)
	if _, err := e.s.AddTask(ctx, NewTask{Title: "follow-up", ParentID: parent.ID, State: StateDoing}); err != nil {
		t.Fatal(err)
	}
	if got := state(parent.ID); got != StateDone {
		t.Errorf("a done parent: %s", got)
	}
}

// A doing task with no worker and no subtask goes back to todo at load; its parent
// follows.
func TestResetOrphansAtLoad(t *testing.T) {
	t.Parallel()
	e := newEnv(t)
	ctx := context.Background()
	worker, err := e.threads.Create(ctx, thread.CreateOptions{Name: "w"})
	if err != nil {
		t.Fatal(err)
	}
	parent, _ := e.s.AddTask(ctx, NewTask{Title: "Batch"})
	orphan, _ := e.s.AddTask(ctx, NewTask{Title: "cut start", ParentID: parent.ID, State: StateDoing})
	working, _ := e.s.AddTask(ctx, NewTask{Title: "working", State: StateDoing, ThreadID: worker.ID})
	lone, _ := e.s.AddTask(ctx, NewTask{Title: "lone cut start", State: StateDoing})
	if got, _ := e.s.Snapshot().Task(parent.ID); got.State != StateDoing {
		t.Fatalf("parent before = %s", got.State)
	}
	if len(e.s.ResetAtStart()) != 0 {
		t.Errorf("a fresh store reset %v", e.s.ResetAtStart())
	}
	e.s.Close()
	e.advance(time.Hour)
	again, err := New(ctx, e.opts)
	if err != nil {
		t.Fatal(err)
	}
	defer again.Close()
	snap := again.Snapshot()
	for _, c := range []struct {
		id   string
		want State
	}{{orphan.ID, StateTodo}, {lone.ID, StateTodo}, {working.ID, StateDoing}, {parent.ID, StateTodo}} {
		if got, _ := snap.Task(c.id); got.State != c.want {
			t.Errorf("%s: %s, want %s", c.id, got.State, c.want)
		}
	}
	if got, _ := snap.Task(orphan.ID); !strings.HasPrefix(got.Outcome, "its worker never started (the app restarted at ") {
		t.Errorf("outcome = %q", got.Outcome)
	}
	var ids []string
	for _, r := range again.ResetAtStart() {
		ids = append(ids, r.ID)
	}
	if !slices.Equal(ids, []string{orphan.ID, lone.ID}) {
		t.Errorf("ResetAtStart = %q", ids)
	}
}

// A reopened doing task hides its worker's report from the earlier run until a new one.
func TestStaleReportHidden(t *testing.T) {
	t.Parallel()
	e := newEnv(t)
	ctx := context.Background()
	worker, err := e.threads.Create(ctx, thread.CreateOptions{Name: "w"})
	if err != nil {
		t.Fatal(err)
	}
	task, _ := e.s.AddTask(ctx, NewTask{Title: "notes field", State: StateDoing, ThreadID: worker.ID})
	report := func(st thread.ReportStatus, summary string) {
		t.Helper()
		e.advance(time.Minute)
		if _, err := e.threads.Report(ctx, worker.ID, thread.Report{Status: st, Summary: summary}); err != nil {
			t.Fatal(err)
		}
	}
	shown := func(what string, want string) {
		t.Helper()
		e.await(what, func(s *Snapshot) bool {
			c, _ := s.Task(task.ID)
			return c.Thread != nil && c.Thread.Report.Summary == want
		})
	}
	report(thread.ReportProgress, "halfway")
	shown("progress", "halfway")
	report(thread.ReportDone, "pushed cf/notes")
	shown("done report", "pushed cf/notes")
	done := StateDone
	e.advance(time.Minute)
	if _, err := e.s.UpdateTask(ctx, task.ID, TaskUpdate{State: &done}); err != nil {
		t.Fatal(err)
	}
	shown("done task", "pushed cf/notes")
	doing := StateDoing
	e.advance(time.Minute)
	got, err := e.s.UpdateTask(ctx, task.ID, TaskUpdate{State: &doing})
	if err != nil || got.Thread == nil || got.Thread.Report.Status != thread.ReportNone {
		t.Fatalf("reopened = %+v, %v; want no report", got.Thread, err)
	}
	if line := RenderBoard(e.s.Snapshot().Tasks, e.clock(), utc); strings.Contains(line, "pushed cf/notes") {
		t.Errorf("board shows the stale report:\n%s", line)
	}
	report(thread.ReportProgress, "markdown next")
	shown("a new report", "markdown next")
}

func TestTaskBranchAndReservedID(t *testing.T) {
	t.Parallel()
	e := newEnv(t)
	ctx := context.Background()
	id, err := NewTaskID()
	if err != nil {
		t.Fatal(err)
	}
	parent, _ := e.s.AddTask(ctx, NewTask{Title: "Batch"})
	child, _ := e.s.AddTask(ctx, NewTask{Title: "piece", ParentID: parent.ID})
	for _, bad := range []struct {
		name string
		n    NewTask
		want error
	}{
		{"no title", NewTask{}, ErrInvalidArgument},
		{"a grandchild", NewTask{Title: "x", ParentID: child.ID}, ErrInvalidArgument},
		{"no such parent", NewTask{Title: "x", ParentID: "t-ffffffff"}, ErrNotFound},
	} {
		if err := e.s.CheckTask(bad.n); !errors.Is(err, bad.want) {
			t.Errorf("CheckTask %s: err = %v", bad.name, err)
		}
	}
	if err := e.s.CheckTask(NewTask{Title: "fine", ParentID: parent.ID}); err != nil {
		t.Errorf("CheckTask = %v", err)
	}
	got, err := e.s.AddTask(ctx, NewTask{ID: id, Title: "reserved"})
	if err != nil || got.ID != id {
		t.Fatalf("AddTask with an id = %+v, %v", got, err)
	}
	if _, err := e.s.AddTask(ctx, NewTask{ID: id, Title: "again"}); !errors.Is(err, ErrInvalidArgument) {
		t.Errorf("the same id twice: %v", err)
	}

	for _, tt := range []struct {
		in, want string
		bad      bool
	}{
		{" origin/cf/notes ", "cf/notes", false},
		{"feat/x", "feat/x", false},
		{"two words", "", true},
		{strings.Repeat("b", 251), "", true},
		{"", "", false},
	} {
		got, err := e.s.UpdateTask(ctx, id, TaskUpdate{Branch: &tt.in})
		switch {
		case tt.bad && !errors.Is(err, ErrInvalidArgument):
			t.Errorf("branch %q: err = %v", tt.in, err)
		case !tt.bad && (err != nil || got.Branch != tt.want):
			t.Errorf("branch %q = %q, %v; want %q", tt.in, got.Branch, err, tt.want)
		}
	}
	b := "cf/notes"
	if _, err := e.s.UpdateTask(ctx, id, TaskUpdate{Branch: &b}); err != nil {
		t.Fatal(err)
	}
	e.s.Close()
	again, err := New(ctx, e.opts)
	if err != nil {
		t.Fatal(err)
	}
	defer again.Close()
	if got, _ := again.Snapshot().Task(id); got.Branch != "cf/notes" {
		t.Errorf("reloaded branch = %q", got.Branch)
	}
}
