package terminal

import (
	"errors"
	"maps"
	"testing"
	"time"
)

func TestSetLabels(t *testing.T) {
	ctx := testCtx(t)
	m := newTestManager(t, Options{})
	term, err := m.Create(ctx, Spec{Argv: []string{"/bin/cat"}, Labels: map[string]string{"kind": "shell", "thread": "s-1"}})
	if err != nil {
		t.Fatal(err)
	}
	events, err := m.Watch(ctx)
	if err != nil {
		t.Fatal(err)
	}
	want := map[string]string{"kind": "shell", "thread": "s-1", "slot": "quick"}
	got, err := m.SetLabels(ctx, term.ID, want)
	if err != nil {
		t.Fatal(err)
	}
	if !maps.Equal(got.Labels, want) || got.Pid != term.Pid || got.State != StateRunning {
		t.Errorf("SetLabels = %+v", got)
	}
	want["slot"] = "changed after the call" // the store keeps its own copy
	if now, _ := m.Get(ctx, term.ID); now.Labels["slot"] != "quick" {
		t.Errorf("Get labels %v", now.Labels)
	}
	deadline := time.After(5 * time.Second)
	for {
		select {
		case ev := <-events:
			if ev.Updated != nil && ev.Updated.ID == term.ID && ev.Updated.Labels["slot"] == "quick" {
				if _, err := m.SetLabels(ctx, "t-none", nil); !errors.Is(err, ErrNotFound) {
					t.Errorf("SetLabels of a missing terminal: %v", err)
				}
				return
			}
		case <-deadline:
			t.Fatal("no TerminalUpdated with the new labels")
		}
	}
}
