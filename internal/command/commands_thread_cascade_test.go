package command_test

import (
	"context"
	"errors"
	"slices"
	"strings"
	"testing"

	"google.golang.org/protobuf/proto"

	v1 "github.com/alexwaumann/code-foundry/gen/go/codefoundry/v1"
	"github.com/alexwaumann/code-foundry/internal/command"
)

// TestThreadArchiveHiddenChildren is thread.archive's confirm matrix with the hidden
// threads the daemon archives along (ThreadFilter.archive_cascade_of).
func TestThreadArchiveHiddenChildren(t *testing.T) {
	connected := v1.ThreadState_THREAD_STATE_CONNECTED
	kid := func(id string, st v1.ThreadState, status v1.ThreadStatus, reason string) *v1.Thread {
		return &v1.Thread{Id: id, CreatedBy: "s5", State: st, Status: status, StatusReason: reason}
	}
	busyKid := kid("k1", connected, v1.ThreadStatus_THREAD_STATUS_BUSY, "working")
	startingKid := kid("k2", v1.ThreadState_THREAD_STATE_STARTING, v1.ThreadStatus_THREAD_STATUS_UNSPECIFIED, "")
	askingKid := kid("k3", connected, v1.ThreadStatus_THREAD_STATUS_NEEDS_ATTENTION, "permission: Bash ls")
	questionKid := kid("k4", connected, v1.ThreadStatus_THREAD_STATUS_NEEDS_ATTENTION, "question: Which?")
	idleKid := kid("k5", connected, v1.ThreadStatus_THREAD_STATUS_IDLE, "at prompt")
	finishedKid := kid("k6", connected, v1.ThreadStatus_THREAD_STATUS_NEEDS_ATTENTION, "finished")
	bgKid := &v1.Thread{Id: "k7", CreatedBy: "s5", State: connected, Status: v1.ThreadStatus_THREAD_STATUS_IDLE, BackgroundShellsRunning: 1}
	stoppedKid := kid("k8", v1.ThreadState_THREAD_STATE_DISCONNECTED, v1.ThreadStatus_THREAD_STATUS_ERROR, "interrupted")
	idleRoot := &v1.Thread{Name: "lead", State: connected, Status: v1.ThreadStatus_THREAD_STATUS_IDLE, StatusReason: "at prompt"}
	busyRoot := &v1.Thread{Name: "lead", State: connected, Status: v1.ThreadStatus_THREAD_STATUS_BUSY}
	const keep1 = "To keep its work, fork it first (code-foundry thread fork --id <id>)."
	const keepN = "To keep the work of one, fork it first (code-foundry thread fork --id <id>)."

	tests := []struct {
		name    string
		args    map[string]string
		current *v1.Thread
		others  []*v1.Thread // for ids
		cascade map[string][]*v1.Thread
		wantAsk string // "" when it runs without asking
	}{
		{name: "nothing live: no question", current: idleRoot,
			cascade: map[string][]*v1.Thread{"s5": {idleKid, finishedKid, stoppedKid}}},
		{name: "no hidden children: no question", current: idleRoot},
		// Background work of a hidden child does not ask: only a turn or a prompt does.
		{name: "a child's background shell: no question", current: idleRoot, cascade: map[string][]*v1.Thread{"s5": {bgKid}}},
		{name: "one working child", current: idleRoot, cascade: map[string][]*v1.Thread{"s5": {idleKid, busyKid}},
			wantAsk: "Archive thread lead? 1 hidden child thread is still working; archiving ends its turn and archives it too. " + keep1},
		{name: "starting, asking and answering children count", current: idleRoot,
			cascade: map[string][]*v1.Thread{"s5": {busyKid, startingKid, askingKid, questionKid, idleKid}},
			wantAsk: "Archive thread lead? 4 hidden child threads are still working; archiving ends their turns and archives them too. " + keepN},
		{name: "the root mid-turn and working children: one question", current: busyRoot,
			cascade: map[string][]*v1.Thread{"s5": {busyKid, askingKid}},
			wantAsk: "Archive thread lead? Claude is still working; archiving ends the turn. " +
				"2 hidden child threads are still working; archiving ends their turns and archives them too. " + keepN},
		{name: "the root mid-turn alone: as before", current: busyRoot, cascade: map[string][]*v1.Thread{"s5": {idleKid}},
			wantAsk: "Archive thread lead? Claude is still working; archiving ends the turn."},
		{name: "unarchiving never asks", args: map[string]string{"id": "s5", "archived": "false"}, current: idleRoot,
			cascade: map[string][]*v1.Thread{"s5": {busyKid}}},
		{name: "ids: a working child of one asks", args: map[string]string{"ids": "s5,s6"},
			others:  []*v1.Thread{{Id: "s5", Name: "lead", State: connected}, {Id: "s6", State: connected}},
			cascade: map[string][]*v1.Thread{"s6": {busyKid}},
			wantAsk: "Archive 2 threads? 1 hidden child thread is still working; archiving ends its turn and archives it too. " + keep1},
		{name: "ids: a child listed itself is counted as a listed thread", args: map[string]string{"ids": "s5,k1"},
			others:  []*v1.Thread{{Id: "s5", State: connected}, busyKid},
			cascade: map[string][]*v1.Thread{"s5": {busyKid}},
			wantAsk: "Archive 2 threads? 1 of them is busy: k1 (Claude is still working). Archiving ends its turn or stops its background work."},
		{name: "ids: one id is the single-thread question", args: map[string]string{"ids": "s5"},
			others:  []*v1.Thread{{Id: "s5", Name: "lead", State: connected}},
			cascade: map[string][]*v1.Thread{"s5": {busyKid}},
			wantAsk: "Archive thread lead? 1 hidden child thread is still working; archiving ends its turn and archives it too. " + keep1},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			reg, b, _ := newLifecycleRegistry(t)
			b.Current, b.Others, b.Cascade = tt.current, tt.others, tt.cascade
			args := tt.args
			if args == nil {
				args = map[string]string{"id": "s5", "archived": "true"}
			}
			_, err := reg.Invoke(context.Background(), command.Context{}, "thread.archive", args)
			var ce *command.ConfirmError
			switch {
			case tt.wantAsk == "" && err != nil:
				t.Fatalf("err = %v, want it to run", err)
			case tt.wantAsk != "" && (!errors.As(err, &ce) || ce.Message != tt.wantAsk):
				t.Fatalf("err = %v,\nwant the confirmation %q", err, tt.wantAsk)
			}
			archived := slices.ContainsFunc(b.Requests(), func(m proto.Message) bool { _, ok := m.(*v1.ArchiveThreadRequest); return ok })
			if archived != (tt.wantAsk == "") {
				t.Errorf("archive requested = %v, want %v", archived, tt.wantAsk == "")
			}
			// The command archives the root (or the ids) only: the daemon cascades.
			for _, m := range b.Requests() {
				if r, ok := m.(*v1.ArchiveThreadRequest); ok && strings.HasPrefix(r.GetId(), "k") && !strings.Contains(args["ids"], r.GetId()) {
					t.Errorf("the command archived the hidden child %s itself", r.GetId())
				}
			}
		})
	}
}

// TestThreadRemoveHiddenChildren: thread.remove names the hidden threads below the
// removed threads that go with them (the daemon removes them too, like an archive), idle
// ones included, with how many are still working; a listed child is not counted twice.
func TestThreadRemoveHiddenChildren(t *testing.T) {
	connected := v1.ThreadState_THREAD_STATE_CONNECTED
	busy := v1.ThreadStatus_THREAD_STATUS_BUSY
	busyKid := &v1.Thread{Id: "k1", CreatedBy: "s5", State: connected, Status: busy}
	askingKid := &v1.Thread{Id: "k2", CreatedBy: "s5", State: connected, Status: v1.ThreadStatus_THREAD_STATUS_NEEDS_ATTENTION, StatusReason: "permission: Bash ls"}
	idleKid := &v1.Thread{Id: "k3", CreatedBy: "s5", State: connected, Status: v1.ThreadStatus_THREAD_STATUS_IDLE}
	busyGrand := &v1.Thread{Id: "g1", CreatedBy: "k3", State: connected, Status: busy}
	const plain = "Remove thread s5? Claude stops if it runs, and the thread is forgotten."
	const keep1 = "To keep its work, fork it first (code-foundry thread fork --id <id>)."
	const keepN = "To keep the work of one, fork it first (code-foundry thread fork --id <id>)."
	tests := []struct {
		name    string
		args    map[string]string
		cascade map[string][]*v1.Thread
		wantAsk string
	}{
		{name: "no hidden children", wantAsk: plain},
		{name: "one idle child", cascade: map[string][]*v1.Thread{"s5": {idleKid}},
			wantAsk: plain + " 1 hidden child thread below it is removed too. " + keep1},
		{name: "idle child and a working grandchild", cascade: map[string][]*v1.Thread{"s5": {idleKid, busyGrand}},
			wantAsk: plain + " 2 hidden child threads below it are (1 still working) removed too. " + keepN},
		{name: "one working child", cascade: map[string][]*v1.Thread{"s5": {busyKid}},
			wantAsk: plain + " 1 hidden child thread below it is still working, and is removed too. " + keep1},
		{name: "two working children", cascade: map[string][]*v1.Thread{"s5": {busyKid, askingKid}},
			wantAsk: plain + " 2 hidden child threads below it are still working, and are removed too. " + keepN},
		{name: "ids: a listed child is not counted", args: map[string]string{"ids": "s5,k1"},
			cascade: map[string][]*v1.Thread{"s5": {busyKid, askingKid}},
			wantAsk: "Remove 2 threads? Claude stops in each that runs, and they are forgotten: s5, k1. " +
				"1 hidden child thread below it is still working, and is removed too. " + keep1},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			reg, b, _ := newLifecycleRegistry(t)
			b.Cascade = tt.cascade
			args := tt.args
			if args == nil {
				args = map[string]string{"id": "s5"}
			}
			_, err := reg.Invoke(context.Background(), command.Context{}, "thread.remove", args)
			var ce *command.ConfirmError
			if !errors.As(err, &ce) || ce.Message != tt.wantAsk {
				t.Fatalf("err = %v,\nwant the confirmation %q", err, tt.wantAsk)
			}
		})
	}
}
