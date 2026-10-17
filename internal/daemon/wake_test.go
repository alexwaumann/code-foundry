package daemon

import (
	"context"
	"errors"
	"io"
	"log/slog"
	"slices"
	"sync"
	"testing"
	"time"

	"github.com/alexwaumann/code-foundry/internal/bus"
	"github.com/alexwaumann/code-foundry/internal/store/action"
)

type recordingWaker struct {
	mu   sync.Mutex
	runs []string
}

func (w *recordingWaker) ActionRunFinished(_ context.Context, id string) {
	w.mu.Lock()
	defer w.mu.Unlock()
	w.runs = append(w.runs, id)
}

func (w *recordingWaker) got() []string {
	w.mu.Lock()
	defer w.mu.Unlock()
	return slices.Clone(w.runs)
}

func TestWakeRuns(t *testing.T) {
	b := bus.New()
	w := &recordingWaker{}
	stop := startWakeRuns(context.Background(), slog.New(slog.NewTextHandler(io.Discard, nil)), w, b)
	defer stop()
	bus.Publish[action.Event](b, action.RunUpdated{Run: action.Run{ID: "r-1"}})
	bus.Publish[action.Event](b, action.RunFinished{RunID: "r-1", ExitCode: 3})
	bus.Publish[action.Event](b, action.RunFinished{RunID: "r-2"})
	deadline := time.Now().Add(2 * time.Second)
	for !slices.Equal(w.got(), []string{"r-1", "r-2"}) {
		if time.Now().After(deadline) {
			t.Fatalf("forwarded = %v", w.got())
		}
		time.Sleep(5 * time.Millisecond)
	}
}

type fakeRunGetter map[string]action.Run

func (f fakeRunGetter) GetRun(_ context.Context, id string) (action.Run, error) {
	r, ok := f[id]
	if !ok {
		return action.Run{}, errors.New("no such run")
	}
	return r, nil
}

func TestActionRunForWake(t *testing.T) {
	at := time.Unix(100, 0)
	get := actionRunForWake(fakeRunGetter{
		"r-1": {ID: "r-1", ActionID: "a-1", ActionName: "Test", ProjectID: "web", State: action.RunExited, ExitCode: 2,
			StartedAt: at, FinishedAt: at.Add(time.Second), Output: "out"},
		"r-2": {ID: "r-2", State: action.RunRunning},
	})
	r, ok := get(context.Background(), "r-1")
	if !ok || !r.Finished || r.ExitCode != 2 || r.ActionName != "Test" || r.ProjectID != "web" || r.Output != "out" || !r.FinishedAt.Equal(at.Add(time.Second)) {
		t.Errorf("r-1 = %+v, %v", r, ok)
	}
	if r, ok := get(context.Background(), "r-2"); !ok || r.Finished {
		t.Errorf("r-2 = %+v, %v", r, ok)
	}
	if _, ok := get(context.Background(), "r-nope"); ok {
		t.Errorf("an unknown run was found")
	}
}
