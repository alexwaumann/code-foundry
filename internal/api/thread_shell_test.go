package api

import (
	"slices"
	"testing"
	"time"

	"github.com/alexwaumann/code-foundry/internal/store/thread"
)

// Thread.background_shells carries what the card shows; the group and Claude's pid stay
// in the daemon.
func TestBackgroundShellsToProto(t *testing.T) {
	at := time.Unix(1700000000, 0)
	got := threadToProto(thread.Thread{ID: "s1", BackgroundShellsRunning: 2, BackgroundShells: []thread.BackgroundShell{
		{TaskID: "b1", Description: "Serve", Command: "python3 -m http.server 9399", StartedAt: at, ClaudePID: 10, PGID: 11, Ports: []int{9399}},
		{TaskID: "b2", Command: "tail -f log"},
	}})
	shells := got.GetBackgroundShells()
	if got.GetBackgroundShellsRunning() != 2 || len(shells) != 2 {
		t.Fatalf("shells %v", shells)
	}
	if s := shells[0]; s.GetTaskId() != "b1" || s.GetDescription() != "Serve" || s.GetCommand() != "python3 -m http.server 9399" ||
		!s.GetStartedAt().AsTime().Equal(at) || !slices.Equal(s.GetPorts(), []uint32{9399}) {
		t.Errorf("first %v", s)
	}
	if s := shells[1]; s.GetStartedAt() != nil || len(s.GetPorts()) != 0 {
		t.Errorf("second %v", s)
	}
	if threadToProto(thread.Thread{ID: "s2"}).GetBackgroundShells() != nil {
		t.Errorf("no shells: want none")
	}
}
