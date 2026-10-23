package ember

import (
	"context"
	"strings"
	"testing"
	"time"

	"github.com/alexwaumann/code-foundry/internal/store/thread"
)

func TestUnclosed(t *testing.T) {
	reported := func(st thread.ReportStatus) thread.Report {
		return thread.Report{Status: st, Summary: "pushed cf/x", At: now.Add(-3 * time.Minute)}
	}
	finished := func(r thread.Report) *TaskThread {
		return &TaskThread{ID: "s-w", State: thread.StateConnected, Status: thread.StatusNeedsAttention, StatusReason: "finished", Report: r}
	}
	doing := func(th *TaskThread) Task {
		return Task{ID: "t-1", Title: "x", State: StateDoing, ThreadID: "s-w", Thread: th}
	}
	busy := finished(reported(thread.ReportDone))
	busy.Status, busy.StatusReason = thread.StatusBusy, "working"
	asks := finished(reported(thread.ReportDone))
	asks.StatusReason = "question: which flag?"
	lead := finished(reported(thread.ReportDone))
	lead.Team = Team{Working: 1, Total: 2}
	teamAsks := finished(reported(thread.ReportDone))
	teamAsks.Team = Team{Waiting: 1, Total: 1}
	stopped := finished(reported(thread.ReportDone))
	stopped.State, stopped.Status, stopped.StatusReason = thread.StateDisconnected, thread.StatusIdle, "at prompt"
	staleWaiting := finished(reported(thread.ReportDone))
	staleWaiting.Status, staleWaiting.StatusReason = thread.StatusIdle, "waiting"
	archived := finished(reported(thread.ReportDone))
	archived.Archived = true
	removed := &TaskThread{ID: "s-w", Removed: true}
	piece := func(id string, st State) Task { return Task{ID: id, Title: id, State: st, ParentID: "t-p"} }
	parent := func(st State) Task { return Task{ID: "t-p", Title: "Two pieces", State: st} }

	tests := []struct {
		name  string
		task  Task
		board []Task
		want  UnclosedKind
		words string
	}{
		{"reported done, idle", doing(finished(reported(thread.ReportDone))), nil, UnclosedReport, "unclosed: worker reported done, waiting for Ember to check"},
		{"reported failed, still doing", doing(finished(reported(thread.ReportFailed))), nil, UnclosedReport, "unclosed: worker reported failed, waiting for Ember to check"},
		{"stopped after its report", doing(stopped), nil, UnclosedReport, ""},
		{"a stale waiting reason", doing(staleWaiting), nil, UnclosedReport, ""},
		{"archived after its report", doing(archived), nil, UnclosedReport, ""},
		{"no report (or a stale one, left out)", doing(finished(thread.Report{})), nil, NotUnclosed, ""},
		{"a progress report", doing(finished(reported(thread.ReportProgress))), nil, NotUnclosed, ""},
		{"busy again after its report", doing(busy), nil, NotUnclosed, ""},
		{"asking the user after its report", doing(asks), nil, NotUnclosed, ""},
		{"a lead whose team works", doing(lead), nil, NotUnclosed, ""},
		{"a lead whose team asks", doing(teamAsks), nil, NotUnclosed, ""},
		{"a removed worker", doing(removed), nil, NotUnclosed, ""},
		{"no worker", Task{ID: "t-1", State: StateDoing}, nil, NotUnclosed, ""},
		{"blocked by its report", Task{ID: "t-1", State: StateBlocked, Thread: finished(reported(thread.ReportBlocked))}, nil, NotUnclosed, ""},
		{"done", Task{ID: "t-1", State: StateDone, Thread: finished(reported(thread.ReportDone))}, nil, NotUnclosed, ""},
		{"a parent with every piece closed", parent(StateDoing), []Task{piece("t-a", StateDone), piece("t-b", StateCancelled)}, UnclosedPieces,
			"unclosed: all its pieces are closed, waiting for Ember to close it"},
		{"a blocked parent with every piece closed", parent(StateBlocked), []Task{piece("t-a", StateDone)}, UnclosedPieces, ""},
		{"a parent with a piece open", parent(StateDoing), []Task{piece("t-a", StateDone), piece("t-b", StateDoing)}, NotUnclosed, ""},
		{"a closed parent", parent(StateDone), []Task{piece("t-a", StateDone)}, NotUnclosed, ""},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			board := append([]Task{tt.task}, tt.board...)
			if got := Unclosed(tt.task, board); got != tt.want {
				t.Errorf("Unclosed = %d, want %d", got, tt.want)
			}
			if tt.words != "" {
				if got := UnclosedWords(tt.task, board); got != tt.words {
					t.Errorf("UnclosedWords = %q, want %q", got, tt.words)
				}
			}
		})
	}
}

func TestUnclosedNote(t *testing.T) {
	idle := func(id string, ago time.Duration) *TaskThread {
		return &TaskThread{ID: id, State: thread.StateDisconnected, Status: thread.StatusNeedsAttention, StatusReason: "finished",
			Report: thread.Report{Status: thread.ReportDone, At: now.Add(-ago)}}
	}
	tasks := []Task{
		{ID: "t-00000001", Title: "Add CONTRIBUTING.md", State: StateDoing, ThreadID: "s-a", Thread: idle("s-a", 12*time.Minute)},
		{ID: "t-00000002", Title: "Add NOTES.md", State: StateDoing, ThreadID: "s-b", Thread: idle("s-b", 10*time.Second)},
		{ID: "t-00000003", Title: "Still going", State: StateDoing, ThreadID: "s-c",
			Thread: &TaskThread{ID: "s-c", State: thread.StateConnected, Status: thread.StatusBusy}},
		{ID: "t-00000004", Title: "Flag and changelog", State: StateDoing},
		{ID: "t-00000005", Title: "Flag", State: StateDone, ParentID: "t-00000004"},
	}
	got := UnclosedNote(tasks, nil, now)
	for _, w := range []string{
		"[code-foundry ember] Unclosed on your board: ",
		"\n- t-00000001 \"Add CONTRIBUTING.md\" · worker s-a reported done 12m ago and is idle\n",
		"- t-00000002 \"Add NOTES.md\" · worker s-b reported done now and is idle\n",
		"- t-00000004 \"Flag and changelog\" · all its pieces are closed",
		"`code-foundry ember task done <id>`",
	} {
		if !strings.Contains(got, w) {
			t.Errorf("note lacks %q:\n%s", w, got)
		}
	}
	if strings.Contains(got, "Still going") || strings.Contains(got, "t-00000005") {
		t.Errorf("note lists a task that is not unclosed:\n%s", got)
	}
	// The wake about s-a reports it itself.
	if got := UnclosedNote(tasks, []string{"s-a"}, now); strings.Contains(got, "t-00000001") || !strings.Contains(got, "t-00000002") {
		t.Errorf("about s-a:\n%s", got)
	}
	if got := UnclosedNote(tasks[2:3], nil, now); got != "" {
		t.Errorf("nothing unclosed = %q", got)
	}
}

// Ember's wakes list the tasks it did not close, as the threads are when the wake goes:
// a worker that reported done and stopped, then the parent once its last piece is done.
func TestWakeNoteListsUnclosed(t *testing.T) {
	t.Parallel()
	e := newEnv(t)
	ctx := context.Background()
	note := func(about ...string) string { return e.threads.WakeNote(Name, about) }
	worker, err := e.threads.Create(ctx, thread.CreateOptions{Name: "w"})
	if err != nil {
		t.Fatal(err)
	}
	parent, _ := e.s.AddTask(ctx, NewTask{Title: "Two pieces"})
	piece, _ := e.s.AddTask(ctx, NewTask{Title: "Notes", ParentID: parent.ID, State: StateDoing, ThreadID: worker.ID})
	other, _ := e.s.AddTask(ctx, NewTask{Title: "Docs", ParentID: parent.ID, State: StateDone})
	e.threads.Put(thread.Thread{ID: worker.ID, Name: "w", State: thread.StateConnected, Status: thread.StatusBusy, StatusReason: "working"})
	if got := note(); got != "" {
		t.Fatalf("a working worker: %q", got)
	}
	e.advance(time.Minute)
	if _, err := e.threads.Report(ctx, worker.ID, thread.Report{Status: thread.ReportDone, Summary: "pushed cf/notes"}); err != nil {
		t.Fatal(err)
	}
	if got := note(); got != "" {
		t.Fatalf("busy after its report: %q", got)
	}
	e.threads.Put(thread.Thread{ID: worker.ID, Name: "w", State: thread.StateConnected, Status: thread.StatusNeedsAttention, StatusReason: "finished",
		Report: thread.Report{Status: thread.ReportDone, Summary: "pushed cf/notes", At: e.clock()}})
	if got := note(); !strings.Contains(got, piece.ID+` "Notes" · worker `+worker.ID+" reported done now and is idle") {
		t.Errorf("idle after its report:\n%s", got)
	}
	if got := note(worker.ID); got != "" {
		t.Errorf("the wake about the worker itself: %q", got)
	}
	// BOARD.md says it too.
	e.await("the board", func(s *Snapshot) bool {
		c, _ := s.Task(piece.ID)
		return Unclosed(c, s.Tasks) == UnclosedReport
	})
	if b := RenderBoard(e.s.Snapshot().Tasks, nil, e.clock(), utc); !strings.Contains(b, piece.ID+" Notes · unclosed: worker reported done, waiting for Ember to check · worker ") {
		t.Errorf("board:\n%s", b)
	}
	done := StateDone
	if _, err := e.s.UpdateTask(ctx, piece.ID, TaskUpdate{State: &done}); err != nil {
		t.Fatal(err)
	}
	if p, ok := e.s.Snapshot().ParentToClose(piece.ID); !ok || p.ID != parent.ID {
		t.Errorf("ParentToClose = %v, %v", p.ID, ok)
	}
	if _, ok := e.s.Snapshot().ParentToClose(parent.ID); ok {
		t.Error("a top-level task has a parent to close")
	}
	got := note(worker.ID)
	if !strings.Contains(got, parent.ID+` "Two pieces" · all its pieces are closed`) || strings.Contains(got, piece.ID) || strings.Contains(got, other.ID) {
		t.Errorf("after the last piece:\n%s", got)
	}
	if _, err := e.s.UpdateTask(ctx, parent.ID, TaskUpdate{State: &done}); err != nil {
		t.Fatal(err)
	}
	if got := note(); got != "" {
		t.Errorf("all closed: %q", got)
	}
	e.s.Close()
	if got := note(); got != "" {
		t.Errorf("after Close: %q", got)
	}
}
