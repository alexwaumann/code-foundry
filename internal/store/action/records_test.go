package action

import (
	"context"
	"testing"
	"time"
)

func TestPickAction(t *testing.T) {
	build, test, lint := Action{ID: "a-build", Name: "Build"}, Action{ID: "a-test", Name: "Test"}, Action{ID: "a-lint", Name: "Lint"}
	actions := []Action{build, test, lint}
	at := func(min int) time.Time { return time.UnixMilli(int64(min) * 60_000) }
	rec := func(action, thread string, trigger Trigger, min int) RunRecord {
		return RunRecord{RunID: "r-" + action + thread, ActionID: action, ThreadID: thread, Trigger: trigger, StartedAt: at(min)}
	}
	tests := []struct {
		name    string
		actions []Action
		records []RunRecord // newest first
		thread  string
		want    PickSource
		action  string
	}{
		{name: "no actions", records: []RunRecord{rec("a-test", "s1", TriggerUser, 3)}, thread: "s1", want: PickNone},
		{name: "nothing ran: the first action", actions: actions, thread: "s1", want: PickFirst, action: "a-build"},
		{name: "the thread's last run wins over a newer one elsewhere", actions: actions, thread: "s1", want: PickThread, action: "a-lint",
			records: []RunRecord{rec("a-test", "s2", TriggerUser, 9), rec("a-lint", "s1", TriggerUser, 5), rec("a-build", "s1", TriggerUser, 2)}},
		{name: "nothing in the thread: the project's newest", actions: actions, thread: "s3", want: PickProject, action: "a-test",
			records: []RunRecord{rec("a-test", "s2", TriggerUser, 9), rec("a-lint", "", TriggerUser, 5)}},
		{name: "a worktree's run counts for the project", actions: actions, thread: "s3", want: PickProject, action: "a-lint",
			records: []RunRecord{rec("a-lint", "", TriggerUser, 5)}},
		{name: "no thread: the project's newest", actions: actions, want: PickProject, action: "a-test",
			records: []RunRecord{rec("a-test", "s2", TriggerUser, 9)}},
		{name: "on-worktree-create runs do not count", actions: actions, thread: "s1", want: PickProject, action: "a-build",
			records: []RunRecord{rec("a-lint", "s1", TriggerWorktreeCreate, 9), rec("a-build", "s2", TriggerUser, 5)}},
		{name: "a removed action is skipped", actions: actions, thread: "s1", want: PickThread, action: "a-test",
			records: []RunRecord{rec("a-gone", "s1", TriggerUser, 9), rec("a-test", "s1", TriggerUser, 5)}},
		{name: "only removed or hook runs: the first action", actions: actions, thread: "s1", want: PickFirst, action: "a-build",
			records: []RunRecord{rec("a-gone", "s1", TriggerUser, 9), rec("a-test", "s1", TriggerWorktreeCreate, 5)}},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			p := PickAction(tt.actions, tt.records, tt.thread)
			if p.Source != tt.want || p.Action.ID != tt.action {
				t.Fatalf("pick = %s %q, want %s %q", p.Source, p.Action.ID, tt.want, tt.action)
			}
			if (p.Source == PickThread || p.Source == PickProject) != (p.Last.RunID != "") || (p.Last.RunID != "" && p.Last.ActionID != tt.action) {
				t.Errorf("last = %+v", p.Last)
			}
		})
	}
}

func TestLatestByAction(t *testing.T) {
	got := LatestByAction([]RunRecord{{RunID: "r3", ActionID: "a"}, {RunID: "r2", ActionID: "b"}, {RunID: "r1", ActionID: "a"}})
	if len(got) != 2 || got["a"].RunID != "r3" || got["b"].RunID != "r2" {
		t.Errorf("LatestByAction = %+v", got)
	}
}

// Every run is recorded when it starts (both runners, both triggers), the records outlive
// the store, deleting an action forgets its records, and a project keeps its newest
// RecordHistory.
func TestRunRecords(t *testing.T) {
	h := newHarness(t)
	ctx := context.Background()
	bg := h.create(CreateOptions{ProjectID: "web", Name: "Build", Command: "true"})
	term := h.create(CreateOptions{ProjectID: "web", Name: "Serve", Command: "true", InTerminal: true})
	gone := h.create(CreateOptions{ProjectID: "api", Name: "Gone", Command: "true"})
	run := func(o RunOptions) Run {
		t.Helper()
		r, err := h.m.Run(ctx, o)
		if err != nil {
			t.Fatal(err)
		}
		return r
	}
	b1 := run(RunOptions{Action: bg.ID, ThreadID: "s1"})
	h.wait(b1.ID)
	t1 := run(RunOptions{Action: term.ID, Worktree: h.web})
	g := run(RunOptions{Action: gone.ID, Worktree: h.api})
	h.wait(g.ID)

	recs, err := h.m.RunRecords(ctx, "web")
	if err != nil {
		t.Fatal(err)
	}
	if len(recs) != 2 || recs[0].RunID != t1.ID || recs[1].RunID != b1.ID {
		t.Fatalf("web records = %+v", recs)
	}
	if r := recs[0]; r.Mode != ModeTerminal || r.ThreadID != "" || r.Trigger != TriggerUser || r.ActionID != term.ID {
		t.Errorf("terminal record = %+v", r)
	}
	if r := recs[1]; r.Mode != ModeBackground || r.ThreadID != "s1" || r.ProjectID != "web" || !r.StartedAt.Equal(b1.StartedAt.Truncate(time.Millisecond)) {
		t.Errorf("background record = %+v (started %v)", r, b1.StartedAt)
	}
	if all, _ := h.m.RunRecords(ctx, ""); len(all) != 3 {
		t.Errorf("every project's records = %d, want 3", len(all))
	}

	// A new store over the same database reads them back; deleting an action forgets its
	// records.
	if err := h.m.Delete(ctx, gone.ID); err != nil {
		t.Fatal(err)
	}
	m2, err := New(ctx, Options{DB: h.db, Projects: h.projects, Log: discard})
	if err != nil {
		t.Fatal(err)
	}
	defer func() { _ = m2.Close(ctx) }()
	if again, _ := m2.RunRecords(ctx, "web"); len(again) != 2 || again[0].RunID != t1.ID {
		t.Errorf("records after a restart = %+v", again)
	}
	if api, _ := m2.RunRecords(ctx, "api"); len(api) != 0 {
		t.Errorf("a deleted action's records = %+v", api)
	}
	if p := PickAction(m2.Snapshot().ForProject("web"), recs, "s1"); p.Source != PickThread || p.Action.ID != bg.ID {
		t.Errorf("pick for s1 = %s %s", p.Source, p.Action.Name)
	}

	// The cap: only the newest per project are kept.
	for i := range 3 {
		r := RunRecord{RunID: "r-cap" + string(rune('a'+i)), ActionID: bg.ID, ProjectID: "web", Mode: ModeBackground, Trigger: TriggerUser,
			StartedAt: time.Now().Add(time.Duration(i+1) * time.Hour)}
		if err := insertRunRecord(ctx, h.db, r, 2); err != nil {
			t.Fatal(err)
		}
	}
	if capped, _ := m2.RunRecords(ctx, "web"); len(capped) != 2 || capped[0].RunID != "r-capc" || capped[1].RunID != "r-capb" {
		t.Errorf("capped records = %+v", capped)
	}
}
