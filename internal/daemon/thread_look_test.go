package daemon

import (
	"context"
	"log/slog"
	"testing"
	"time"

	"github.com/alexwaumann/code-foundry/internal/bus"
	"github.com/alexwaumann/code-foundry/internal/command"
	"github.com/alexwaumann/code-foundry/internal/store/notification"
	"github.com/alexwaumann/code-foundry/internal/store/notification/notificationtest"
	"github.com/alexwaumann/code-foundry/internal/store/thread"
)

func TestLookStatusTurnedAttention(t *testing.T) {
	tests := []struct {
		name string
		seed []thread.Status // the thread's status at start, if any
		then []thread.Status
		want []bool
	}{
		{"waiting then done", []thread.Status{thread.StatusIdle}, []thread.Status{thread.StatusBusy, thread.StatusIdle, thread.StatusBusy, thread.StatusNeedsAttention},
			[]bool{false, false, false, true}},
		{"an ask while busy", []thread.Status{thread.StatusBusy}, []thread.Status{thread.StatusNeedsAttention}, []bool{true}},
		{"still needing attention", []thread.Status{thread.StatusNeedsAttention}, []thread.Status{thread.StatusNeedsAttention, thread.StatusIdle, thread.StatusNeedsAttention},
			[]bool{false, false, true}},
		{"first heard of needing attention", nil, []thread.Status{thread.StatusNeedsAttention}, []bool{true}},
		{"an error is not", []thread.Status{thread.StatusBusy}, []thread.Status{thread.StatusError, thread.StatusIdle}, []bool{false, false}},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			l := lookStatus{}
			snap := &thread.Snapshot{}
			for _, st := range tt.seed {
				snap.Threads = append(snap.Threads, thread.Thread{ID: "s-1", Status: st})
			}
			l.seed(snap)
			for i, st := range tt.then {
				if got := l.turnedAttention(thread.Thread{ID: "s-1", Status: st}); got != tt.want[i] {
					t.Fatalf("step %d (%v): turned = %v, want %v", i, st, got, tt.want[i])
				}
			}
		})
	}
}

// The glue withdraws a thread's request to look when the user sees the thread and when
// its status turns to needs attention, and leaves it otherwise.
func TestThreadLookGlue(t *testing.T) {
	ctx := context.Background()
	b := bus.New()
	s := notificationtest.New(t, notificationtest.Options{Bus: b})
	th := newFakeFlagThreads()
	th.snap.Threads[0].Status, th.snap.Threads[1].Status = thread.StatusBusy, thread.StatusBusy
	changes := bus.Subscribe[notification.Event](b, 64)
	defer changes.Close()
	stop := startThreadLook(ctx, slog.New(slog.DiscardHandler), th, th.Snapshot, s, b)
	defer stop()

	post := func(id string) {
		t.Helper()
		if _, err := s.Post(ctx, command.LookPost(id, "Look at "+id, "")); err != nil {
			t.Fatal(err)
		}
		<-changes.C()
	}
	active := func(id string) bool {
		_, ok := s.Active(notification.SourceCommand, notification.LookKey(id))
		return ok
	}
	// withdrawn waits for the next change and says whether it withdrew id's request.
	withdrawn := func(id string) {
		t.Helper()
		select {
		case <-changes.C():
		case <-time.After(5 * time.Second):
			t.Fatalf("nothing withdrew %s's request", id)
		}
		if active(id) {
			t.Fatalf("%s's request is still active", id)
		}
	}
	updated := func(id string, st thread.Status) {
		bus.Publish[thread.Event](b, thread.Updated{Thread: thread.Thread{ID: id, Status: st}})
	}

	post("s-1")
	post("s-2")
	// Waiting (idle), busy again for a wake: nothing goes.
	updated("s-1", thread.StatusIdle)
	updated("s-1", thread.StatusBusy)
	// s-2's turn ends needing the user: its request goes; s-1's, after it in order, stays.
	updated("s-2", thread.StatusNeedsAttention)
	withdrawn("s-2")
	if !active("s-1") {
		t.Fatal("s-1's request went while it was waiting")
	}
	// The user sees s-1: its request goes.
	th.mu.Lock()
	hook := th.hook
	th.mu.Unlock()
	hook("s-1")
	withdrawn("s-1")
	// Asked again, then s-1's turn ends Done.
	post("s-1")
	updated("s-1", thread.StatusNeedsAttention)
	withdrawn("s-1")
	// Seeing a thread with no request changes nothing.
	hook("s-2")
	post("s-2")
	if !active("s-2") {
		t.Fatal("s-2's new request is not active")
	}
}
