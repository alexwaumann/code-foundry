package command_test

import (
	"context"
	"errors"
	"slices"
	"testing"
	"time"

	"connectrpc.com/connect"
	"google.golang.org/protobuf/proto"
	"google.golang.org/protobuf/types/known/timestamppb"

	v1 "github.com/alexwaumann/code-foundry/gen/go/codefoundry/v1"
	"github.com/alexwaumann/code-foundry/internal/command"
)

func TestThreadArchive(t *testing.T) {
	connected := v1.ThreadState_THREAD_STATE_CONNECTED
	live := func(status v1.ThreadStatus, reason string) *v1.Thread {
		return &v1.Thread{Name: "drv", State: connected, Status: status, StatusReason: reason}
	}
	busy := live(v1.ThreadStatus_THREAD_STATUS_BUSY, "working")
	archivedAt := timestamppb.New(time.UnixMilli(42))
	get := &v1.GetThreadRequest{Id: "s5"}
	cascade := &v1.ListThreadsRequest{Filter: &v1.ThreadFilter{ArchiveCascadeOf: "s5"}}
	archive := &v1.ArchiveThreadRequest{Id: "s5", Archived: true}
	unarchive := &v1.ArchiveThreadRequest{Id: "s5"}
	const working = "Archive thread drv? Claude is still working; archiving ends the turn."
	const waiting = "Archive thread drv? Claude is waiting on your answer; archiving ends the turn."

	tests := []struct {
		name       string
		ctx        command.Context
		args       map[string]string
		current    *v1.Thread
		confirmed  bool
		backendErr error
		wantErr    error
		wantCode   connect.Code
		wantAsk    string // the confirmation asked for; "" when it ran
		wantMsg    string
		wantReqs   []proto.Message
	}{
		{name: "toggle archives an idle thread without asking", ctx: command.Context{ActiveThreadID: "s5"},
			current: live(v1.ThreadStatus_THREAD_STATUS_IDLE, "at prompt"),
			wantMsg: "archived thread drv (s5)", wantReqs: []proto.Message{get, cascade, get, archive}},
		{name: "a finished turn archives without asking", args: map[string]string{"id": "s5", "archived": "true"},
			current: live(v1.ThreadStatus_THREAD_STATUS_NEEDS_ATTENTION, "finished"),
			wantMsg: "archived thread drv (s5)", wantReqs: []proto.Message{get, cascade, archive}},
		{name: "a failed turn archives without asking", args: map[string]string{"id": "s5", "archived": "true"},
			current: live(v1.ThreadStatus_THREAD_STATUS_NEEDS_ATTENTION, "error: rate_limit"),
			wantMsg: "archived thread drv (s5)"},
		{name: "a disconnected thread archives without asking", args: map[string]string{"id": "s5", "archived": "true"},
			current: &v1.Thread{Name: "drv", State: v1.ThreadState_THREAD_STATE_DISCONNECTED, Status: v1.ThreadStatus_THREAD_STATUS_ERROR, StatusReason: "interrupted"},
			wantMsg: "archived thread drv (s5)"},
		{name: "a closing thread archives without asking", args: map[string]string{"id": "s5", "archived": "true"},
			current: &v1.Thread{Name: "drv", State: v1.ThreadState_THREAD_STATE_CLOSING, Status: v1.ThreadStatus_THREAD_STATUS_BUSY},
			wantMsg: "archived thread drv (s5)"},
		{name: "a working thread asks", ctx: command.Context{ActiveThreadID: "s5"}, current: busy,
			wantAsk: working, wantReqs: []proto.Message{get, cascade, get, cascade}},
		{name: "a starting thread asks", args: map[string]string{"id": "s5", "archived": "true"},
			current: &v1.Thread{Name: "drv", State: v1.ThreadState_THREAD_STATE_STARTING}, wantAsk: working},
		{name: "a pending permission asks", args: map[string]string{"id": "s5", "archived": "true"},
			current: live(v1.ThreadStatus_THREAD_STATUS_NEEDS_ATTENTION, "permission: Bash rm -rf x"), wantAsk: waiting},
		{name: "a pending question asks", args: map[string]string{"id": "s5", "archived": "true"},
			current: live(v1.ThreadStatus_THREAD_STATUS_NEEDS_ATTENTION, "question: Which one?"), wantAsk: waiting},
		// Background work stops with the process (a dev server, a long agent).
		{name: "a background shell asks", args: map[string]string{"id": "s5", "archived": "true"},
			current: &v1.Thread{Name: "drv", State: connected, Status: v1.ThreadStatus_THREAD_STATUS_IDLE, BackgroundShellsRunning: 1},
			wantAsk: "Archive thread drv? 1 background shell is running; archiving stops it."},
		{name: "background agents and shells ask", args: map[string]string{"id": "s5", "archived": "true"},
			current: &v1.Thread{Name: "drv", State: connected, Status: v1.ThreadStatus_THREAD_STATUS_NEEDS_ATTENTION, StatusReason: "finished",
				BackgroundAgentsRunning: 2, BackgroundShellsRunning: 1},
			wantAsk: "Archive thread drv? 2 background agents and 1 shell are running; archiving stops them."},
		{name: "Claude's turn after a background end asks", args: map[string]string{"id": "s5", "archived": "true"},
			current: &v1.Thread{Name: "drv", State: connected, Status: v1.ThreadStatus_THREAD_STATUS_IDLE, BackgroundWakePending: true},
			wantAsk: "Archive thread drv? Claude is about to report background work that just finished; archiving loses that report."},
		{name: "a working turn is named before background work", args: map[string]string{"id": "s5", "archived": "true"},
			current: &v1.Thread{Name: "drv", State: connected, Status: v1.ThreadStatus_THREAD_STATUS_BUSY, BackgroundAgentsRunning: 1},
			wantAsk: working},
		{name: "an unnamed thread is asked about by id", args: map[string]string{"id": "s5", "archived": "true"},
			current: &v1.Thread{State: connected, Status: v1.ThreadStatus_THREAD_STATUS_BUSY},
			wantAsk: "Archive thread s5? Claude is still working; archiving ends the turn."},
		{name: "a working thread archives once confirmed", args: map[string]string{"id": "s5"}, current: busy, confirmed: true,
			wantMsg: "archived thread drv (s5)", wantReqs: []proto.Message{get, archive}},
		{name: "toggle unarchives without asking, even a working thread", args: map[string]string{"id": "s5"},
			current: &v1.Thread{Name: "drv", State: connected, Status: v1.ThreadStatus_THREAD_STATUS_BUSY, ArchivedAt: archivedAt},
			wantMsg: "unarchived thread drv (s5)", wantReqs: []proto.Message{get, get, unarchive}},
		{name: "explicit unarchive", args: map[string]string{"id": "s5", "archived": "false"},
			current: &v1.Thread{Name: "drv", State: v1.ThreadState_THREAD_STATE_DISCONNECTED, ArchivedAt: archivedAt},
			wantMsg: "unarchived thread drv (s5)", wantReqs: []proto.Message{get, unarchive}},
		{name: "re-archiving an archived thread", args: map[string]string{"id": "s5", "archived": "true"},
			current: &v1.Thread{Name: "drv", State: v1.ThreadState_THREAD_STATE_DISCONNECTED, ArchivedAt: archivedAt},
			wantMsg: "archived thread drv (s5)", wantReqs: []proto.Message{get, cascade, archive}},
		{name: "unavailable in the GUI without a thread", ctx: command.Context{ActiveView: "dashboard"}, wantErr: command.ErrUnavailable},
		// The CLI may name its threads with ids alone, so Run says what is missing.
		{name: "the CLI without a thread names what is missing", wantErr: command.ErrInvalidArgs},
		{name: "an unknown thread fails in Run, not with a confirmation", args: map[string]string{"id": "s5", "archived": "true"},
			backendErr: connect.NewError(connect.CodeNotFound, errors.New("nope")), wantCode: connect.CodeNotFound},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			reg, b, _ := newLifecycleRegistry(t)
			b.Current, b.Err = tt.current, tt.backendErr
			res, err := reg.Invoke(context.Background(), tt.ctx, "thread.archive", tt.args, command.Confirmed(tt.confirmed))
			switch {
			case tt.wantCode != 0:
				if connect.CodeOf(err) != tt.wantCode {
					t.Fatalf("err = %v, want code %v", err, tt.wantCode)
				}
			case tt.wantErr != nil:
				if !errors.Is(err, tt.wantErr) {
					t.Fatalf("err = %v, want %v", err, tt.wantErr)
				}
			case tt.wantAsk != "":
				var ce *command.ConfirmError
				if !errors.As(err, &ce) || ce.Message != tt.wantAsk || ce.Title != "Archive or Unarchive Thread" {
					t.Fatalf("err = %v, want the confirmation %q", err, tt.wantAsk)
				}
			case err != nil:
				t.Fatal(err)
			}
			if tt.wantMsg != "" && res.Message != tt.wantMsg {
				t.Errorf("message = %q, want %q", res.Message, tt.wantMsg)
			}
			got := b.Requests()
			if tt.wantReqs != nil && !slices.EqualFunc(got, tt.wantReqs, proto.Equal) {
				t.Errorf("requests = %v, want %v", got, tt.wantReqs)
			}
			if tt.wantAsk != "" && slices.ContainsFunc(got, func(m proto.Message) bool { _, ok := m.(*v1.ArchiveThreadRequest); return ok }) {
				t.Error("archived without the confirmation")
			}
		})
	}
}

func TestThreadArchiveListsAsConfirmable(t *testing.T) {
	reg, _, _ := newLifecycleRegistry(t)
	c, ok := reg.Get("thread.archive")
	if !ok || c.Confirm == "" || c.Category != "Thread" {
		t.Fatalf("thread.archive = %+v", c)
	}
}
