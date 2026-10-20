package ember

import (
	"context"
	"fmt"
	"testing"
	"time"

	"github.com/alexwaumann/code-foundry/internal/store/thread"
)

func TestTeam(t *testing.T) {
	t0 := time.Date(2026, 10, 20, 9, 0, 0, 0, time.UTC)
	th := func(id, by string, min int, status thread.Status, reason string) thread.Thread {
		return thread.Thread{ID: id, CreatedBy: by, CreatedAt: t0.Add(time.Duration(min) * time.Minute), Name: "n-" + id,
			State: thread.StateConnected, Status: status, StatusReason: reason}
	}
	archived := th("s-arch", "s-lead", 5, thread.StatusIdle, "at prompt")
	archived.ArchivedAt = t0
	stopped := th("s-stop", "s-lead", 6, thread.StatusNeedsAttention, "question: which?")
	stopped.State = thread.StateDisconnected
	starting := th("s-start", "s-lead", 7, thread.StatusUnknown, "")
	starting.State = thread.StateStarting
	base := []thread.Thread{
		th("s-ember", "", 0, thread.StatusIdle, "at prompt"),
		th("s-lead", "s-ember", 1, thread.StatusIdle, "waiting on 3 child threads"),
		th("s-w1", "s-lead", 2, thread.StatusBusy, "working"),
		th("s-w2", "s-lead", 3, thread.StatusNeedsAttention, "permission: Bash npm test"),
		th("s-sub", "s-lead", 4, thread.StatusIdle, "waiting on 1 child thread"),
		th("s-deep", "s-sub", 8, thread.StatusNeedsAttention, "question: which port?"),
		th("s-done", "s-lead", 9, thread.StatusNeedsAttention, "finished"),
		archived, stopped, starting,
	}
	many := []thread.Thread{th("s-big", "", 0, thread.StatusBusy, "working")}
	for i := range 12 {
		many = append(many, th(fmt.Sprintf("s-k%02d", i), "s-big", i+1, thread.StatusBusy, "working"))
	}
	tests := []struct {
		name                    string
		threads                 []thread.Thread
		root                    string
		working, waiting, total int
		members                 []string
	}{
		{name: "a lead's team, depth first", threads: base, root: "s-lead", working: 3, waiting: 2, total: 7,
			members: []string{"s-w1", "s-w2", "s-sub", "s-deep", "s-stop", "s-start", "s-done"}},
		{name: "a worker with no children", threads: base, root: "s-w1"},
		{name: "a sub-lead", threads: base, root: "s-sub", waiting: 1, total: 1, members: []string{"s-deep"}},
		{name: "ten listed of twelve", threads: many, root: "s-big", working: 12, total: 12,
			members: []string{"s-k00", "s-k01", "s-k02", "s-k03", "s-k04", "s-k05", "s-k06", "s-k07", "s-k08", "s-k09"}},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			got := newTeamIndex(&thread.Snapshot{Threads: tt.threads}).team(tt.root)
			if got.Working != tt.working || got.Waiting != tt.waiting || got.Total != tt.total {
				t.Errorf("counts = %d working, %d waiting, %d total; want %d, %d, %d", got.Working, got.Waiting, got.Total, tt.working, tt.waiting, tt.total)
			}
			var ids []string
			for _, m := range got.Members {
				ids = append(ids, m.ID)
			}
			if fmt.Sprint(ids) != fmt.Sprint(tt.members) {
				t.Errorf("members = %v, want %v", ids, tt.members)
			}
		})
	}
	if m := newTeamIndex(&thread.Snapshot{Threads: base}).team("s-lead").Members[3]; m.Depth != 2 || m.Name != "n-s-deep" {
		t.Errorf("s-deep = depth %d name %q, want 2 n-s-deep", m.Depth, m.Name)
	}
}

func TestTaskTeamPublished(t *testing.T) {
	t.Parallel()
	e := newEnv(t)
	ctx := context.Background()
	lead, err := e.threads.Create(ctx, thread.CreateOptions{Name: "lead"})
	if err != nil {
		t.Fatal(err)
	}
	open, err := e.s.AddTask(ctx, NewTask{Title: "Lead the team", ThreadID: lead.ID, State: StateDoing})
	if err != nil {
		t.Fatal(err)
	}
	finished, err := e.s.AddTask(ctx, NewTask{Title: "Done before", ThreadID: lead.ID, State: StateDone})
	if err != nil {
		t.Fatal(err)
	}
	// A worker the lead created starts, then asks the user something: the board follows.
	e.threads.Put(thread.Thread{ID: "s-worker", Name: "worker", CreatedBy: lead.ID, State: thread.StateConnected, Status: thread.StatusBusy})
	e.await("the worker working", func(s *Snapshot) bool {
		c, _ := s.Task(open.ID)
		return c.Thread != nil && c.Thread.Team.Working == 1 && c.Thread.Team.Total == 1
	})
	e.threads.Put(thread.Thread{ID: "s-worker", Name: "worker", CreatedBy: lead.ID, State: thread.StateConnected,
		Status: thread.StatusNeedsAttention, StatusReason: "question: which port?"})
	snap := e.await("the worker waiting", func(s *Snapshot) bool {
		c, _ := s.Task(open.ID)
		return c.Thread != nil && c.Thread.Team.Waiting == 1 && c.Thread.Team.Working == 0
	})
	if c, _ := snap.Task(open.ID); len(c.Thread.Team.Members) != 1 || c.Thread.Team.Members[0].StatusReason != "question: which port?" {
		t.Errorf("members = %+v", c.Thread.Team.Members)
	}
	if c, _ := snap.Task(finished.ID); c.Thread.Team.Total != 0 || c.Thread.Team.Members != nil {
		t.Errorf("a done task's team = %+v, want none", c.Thread.Team)
	}
}
