package daemon

import (
	"context"
	"io"
	"log/slog"
	"sync"
	"testing"
	"time"

	"github.com/alexwaumann/code-foundry/internal/bus"
	"github.com/alexwaumann/code-foundry/internal/store/thread"
)

func TestTurnEndWorkspace(t *testing.T) {
	snap := &thread.Snapshot{Threads: []thread.Thread{
		{ID: "t-ws", WorkspaceID: "w-1"},
		{ID: "t-plain"},
	}}
	end := thread.Item{Kind: thread.KindTurnEnd}
	tests := []struct {
		name string
		ev   thread.ThreadEvent
		snap *thread.Snapshot
		want string
	}{
		{name: "turn end of a workspace thread", ev: thread.ItemAppended{ThreadID: "t-ws", Item: end}, snap: snap, want: "w-1"},
		{name: "turn end without a workspace", ev: thread.ItemAppended{ThreadID: "t-plain", Item: end}, snap: snap},
		{name: "unknown thread", ev: thread.ItemAppended{ThreadID: "t-gone", Item: end}, snap: snap},
		{name: "assistant text", ev: thread.ItemAppended{ThreadID: "t-ws", Item: thread.Item{Kind: thread.KindAssistantText}}, snap: snap},
		{name: "an update, not an append", ev: thread.ItemUpdated{ThreadID: "t-ws", Item: end}, snap: snap},
		{name: "no snapshot", ev: thread.ItemAppended{ThreadID: "t-ws", Item: end}},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			if got := turnEndWorkspace(tt.ev, tt.snap); got != tt.want {
				t.Fatalf("turnEndWorkspace = %q, want %q", got, tt.want)
			}
		})
	}
}

type dirsRecorder struct {
	mu  sync.Mutex
	ids []string
}

func (d *dirsRecorder) EnsureDirs(_ context.Context, id string) error {
	d.mu.Lock()
	defer d.mu.Unlock()
	d.ids = append(d.ids, id)
	return nil
}

func (d *dirsRecorder) got() []string {
	d.mu.Lock()
	defer d.mu.Unlock()
	return append([]string(nil), d.ids...)
}

// A workspace thread's turn end has the store read its managed dir again.
func TestWorkspaceContentsGlue(t *testing.T) {
	b := bus.New()
	snap := &thread.Snapshot{Threads: []thread.Thread{{ID: "t-ws", WorkspaceID: "w-1"}}}
	rec := &dirsRecorder{}
	stop := startWorkspaceContents(context.Background(), slog.New(slog.NewTextHandler(io.Discard, nil)), func() *thread.Snapshot { return snap }, rec, b)
	defer stop()
	bus.Publish[thread.ThreadEvent](b, thread.ItemAppended{ThreadID: "t-ws", Item: thread.Item{Kind: thread.KindAssistantText}})
	bus.Publish[thread.ThreadEvent](b, thread.ItemAppended{ThreadID: "t-ws", Item: thread.Item{Kind: thread.KindTurnEnd}})
	deadline := time.Now().Add(5 * time.Second)
	for len(rec.got()) == 0 && time.Now().Before(deadline) {
		time.Sleep(5 * time.Millisecond)
	}
	if got := rec.got(); len(got) != 1 || got[0] != "w-1" {
		t.Fatalf("EnsureDirs calls %v, want [w-1]", got)
	}
}
