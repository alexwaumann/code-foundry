package command_test

import (
	"context"
	"errors"
	"slices"
	"strings"
	"testing"
	"time"

	"connectrpc.com/connect"
	"google.golang.org/protobuf/proto"
	"google.golang.org/protobuf/types/known/timestamppb"

	v1 "github.com/alexwaumann/code-foundry/gen/go/codefoundry/v1"
	"github.com/alexwaumann/code-foundry/internal/command"
)

func TestThreadSnooze(t *testing.T) {
	connected := v1.ThreadState_THREAD_STATE_CONNECTED
	live := func(status v1.ThreadStatus, reason string) *v1.Thread {
		return &v1.Thread{Name: "drv", State: connected, Status: status, StatusReason: reason}
	}
	idle := live(v1.ThreadStatus_THREAD_STATUS_IDLE, "at prompt")
	busy := live(v1.ThreadStatus_THREAD_STATUS_BUSY, "working")
	far := time.Date(2099, time.January, 2, 15, 4, 0, 0, time.UTC)
	farMsg := "snoozed thread drv (s5) until " + far.In(time.Local).Format("Mon Jan 2 2006 3:04 PM")
	snoozeFar := &v1.SnoozeThreadRequest{Id: "s5", Until: timestamppb.New(far)}
	unsnooze := &v1.SnoozeThreadRequest{Id: "s5"}

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
		wantReqs   []proto.Message // nil: not checked
		// wantUntil, when set, is checked against the Snooze request's until (within a
		// second, for durations from now).
		wantUntil time.Duration
	}{
		{name: "an idle thread snoozes without asking", ctx: command.Context{ActiveThreadID: "s5"}, args: map[string]string{"until": "2099-01-02T15:04:00Z"},
			current: idle, wantMsg: farMsg, wantReqs: []proto.Message{&v1.SnoozeThreadRequest{Id: "s5", Until: timestamppb.New(far), ByThreadId: "s5"}}},
		{name: "a duration is from now", args: map[string]string{"id": "s5", "until": "90m"},
			current: idle, wantUntil: 90 * time.Minute},
		{name: "a finished turn snoozes without asking", args: map[string]string{"id": "s5", "until": "2099-01-02T15:04:00Z"},
			current: live(v1.ThreadStatus_THREAD_STATUS_NEEDS_ATTENTION, "finished"), wantMsg: farMsg},
		{name: "a disconnected thread snoozes without asking", args: map[string]string{"id": "s5", "until": "2099-01-02T15:04:00Z"},
			current: &v1.Thread{Name: "drv", State: v1.ThreadState_THREAD_STATE_DISCONNECTED, Status: v1.ThreadStatus_THREAD_STATUS_ERROR, StatusReason: "interrupted"},
			wantMsg: farMsg},
		// A snooze cuts nothing off (docs/notes/snooze-without-teardown.md): never a question.
		{name: "a working thread snoozes without asking", args: map[string]string{"id": "s5", "until": "2099-01-02T15:04:00Z"}, current: busy,
			wantMsg: farMsg, wantReqs: []proto.Message{snoozeFar}},
		{name: "a starting thread snoozes without asking", args: map[string]string{"id": "s5", "until": "2099-01-02T15:04:00Z"},
			current: &v1.Thread{Name: "drv", State: v1.ThreadState_THREAD_STATE_STARTING}, wantMsg: farMsg, wantReqs: []proto.Message{snoozeFar}},
		{name: "a pending permission snoozes without asking", args: map[string]string{"id": "s5", "until": "2099-01-02T15:04:00Z"},
			current: live(v1.ThreadStatus_THREAD_STATUS_NEEDS_ATTENTION, "permission: Bash rm -rf x"), wantMsg: farMsg, wantReqs: []proto.Message{snoozeFar}},
		{name: "a pending question snoozes without asking", args: map[string]string{"id": "s5", "until": "2099-01-02T15:04:00Z"},
			current: live(v1.ThreadStatus_THREAD_STATUS_NEEDS_ATTENTION, "question: Which one?"), wantMsg: farMsg, wantReqs: []proto.Message{snoozeFar}},
		{name: "background agents snooze without asking", args: map[string]string{"id": "s5", "until": "2099-01-02T15:04:00Z"},
			current: &v1.Thread{Name: "drv", State: connected, Status: v1.ThreadStatus_THREAD_STATUS_IDLE, BackgroundAgentsRunning: 2, BackgroundShellsRunning: 1},
			wantMsg: farMsg, wantReqs: []proto.Message{snoozeFar}},
		{name: "clear unsnoozes without asking, even a working thread", args: map[string]string{"id": "s5", "clear": "true"},
			current: busy, wantMsg: "unsnoozed thread drv (s5)", wantReqs: []proto.Message{unsnooze}},
		{name: "save puts an idle thread away without asking", args: map[string]string{"id": "s5", "save": "true"},
			current: idle, wantMsg: "saved thread drv (s5) for later", wantReqs: []proto.Message{&v1.SnoozeThreadRequest{Id: "s5", Save: true}}},
		{name: "save does not ask while Claude works", args: map[string]string{"id": "s5", "save": "true"}, current: busy,
			wantMsg: "saved thread drv (s5) for later", wantReqs: []proto.Message{&v1.SnoozeThreadRequest{Id: "s5", Save: true}}},
		{name: "save does not ask while Claude waits on an answer", args: map[string]string{"id": "s5", "save": "true"},
			current: live(v1.ThreadStatus_THREAD_STATUS_NEEDS_ATTENTION, "question: Which one?"),
			wantMsg: "saved thread drv (s5) for later", wantReqs: []proto.Message{&v1.SnoozeThreadRequest{Id: "s5", Save: true}}},
		{name: "clear ends a save", args: map[string]string{"id": "s5", "clear": "true"},
			current: &v1.Thread{Name: "drv", SavedAt: timestamppb.New(far)}, wantMsg: "unsnoozed thread drv (s5)", wantReqs: []proto.Message{unsnooze}},
		{name: "save and until together", args: map[string]string{"id": "s5", "save": "true", "until": "1h"}, current: busy,
			wantErr: command.ErrInvalidArgs, wantReqs: []proto.Message{}},
		{name: "save and clear together", args: map[string]string{"id": "s5", "save": "true", "clear": "true"}, current: busy,
			wantErr: command.ErrInvalidArgs, wantReqs: []proto.Message{}},
		{name: "neither until nor clear", args: map[string]string{"id": "s5"}, current: busy,
			wantErr: command.ErrInvalidArgs, wantReqs: []proto.Message{}},
		{name: "clear=false is not an unsnooze", args: map[string]string{"id": "s5", "clear": "false"}, current: idle,
			wantErr: command.ErrInvalidArgs, wantReqs: []proto.Message{}},
		{name: "until and clear together", args: map[string]string{"id": "s5", "until": "1h", "clear": "true"}, current: busy,
			wantErr: command.ErrInvalidArgs, wantReqs: []proto.Message{}},
		{name: "an unparsable until fails without asking", args: map[string]string{"id": "s5", "until": "soon"}, current: busy,
			wantErr: command.ErrInvalidArgs, wantReqs: []proto.Message{}},
		{name: "a past until fails without asking", args: map[string]string{"id": "s5", "until": "2001-01-01"}, current: busy,
			wantErr: command.ErrInvalidArgs, wantReqs: []proto.Message{}},
		{name: "missing a thread", args: map[string]string{"until": "1h"}, wantErr: command.ErrInvalidArgs},
		{name: "an unknown thread fails in Run, not with a confirmation", args: map[string]string{"id": "s5", "until": "1h"},
			backendErr: connect.NewError(connect.CodeNotFound, errors.New("nope")), wantCode: connect.CodeNotFound},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			reg, b, _ := newLifecycleRegistry(t)
			b.Current, b.Err = tt.current, tt.backendErr
			before := time.Now()
			res, err := reg.Invoke(context.Background(), tt.ctx, "thread.snooze", tt.args, command.Confirmed(tt.confirmed))
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
				if !errors.As(err, &ce) || ce.Message != tt.wantAsk || ce.Title != "Snooze or Unsnooze Thread" {
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
			snoozes := slices.DeleteFunc(slices.Clone(got), func(m proto.Message) bool { _, ok := m.(*v1.SnoozeThreadRequest); return !ok })
			if tt.wantAsk != "" && len(snoozes) > 0 {
				t.Error("snoozed without the confirmation")
			}
			if tt.wantUntil != 0 {
				if len(snoozes) != 1 {
					t.Fatalf("snooze requests = %v", snoozes)
				}
				until := snoozes[0].(*v1.SnoozeThreadRequest).GetUntil().AsTime()
				if until.Before(before.Add(tt.wantUntil)) || until.After(time.Now().Add(tt.wantUntil)) {
					t.Errorf("until = %v, want now + %v", until, tt.wantUntil)
				}
				if !strings.HasPrefix(res.Message, "snoozed thread drv (s5) until ") {
					t.Errorf("message = %q", res.Message)
				}
			}
		})
	}
}

// A snooze cuts nothing off, so thread.snooze has no confirmation of any kind
// (docs/notes/snooze-without-teardown.md).
func TestThreadSnoozeNeverConfirms(t *testing.T) {
	reg, _, _ := newLifecycleRegistry(t)
	c, ok := reg.Get("thread.snooze")
	if !ok || c.Confirm != "" || c.ConfirmIf != nil || c.DynamicConfirm != nil || c.Category != "Thread" {
		t.Fatalf("thread.snooze = %+v", c)
	}
}
