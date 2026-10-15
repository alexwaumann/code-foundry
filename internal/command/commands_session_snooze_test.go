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

func TestSessionSnooze(t *testing.T) {
	connected := v1.SessionState_SESSION_STATE_CONNECTED
	live := func(status v1.SessionStatus, reason string) *v1.Session {
		return &v1.Session{Name: "drv", State: connected, Status: status, StatusReason: reason}
	}
	idle := live(v1.SessionStatus_SESSION_STATUS_IDLE, "at prompt")
	busy := live(v1.SessionStatus_SESSION_STATUS_BUSY, "working")
	far := time.Date(2099, time.January, 2, 15, 4, 0, 0, time.UTC)
	farMsg := "snoozed thread drv (s5) until " + far.In(time.Local).Format("Mon Jan 2 2006 3:04 PM")
	get := &v1.GetSessionRequest{Id: "s5"}
	snoozeFar := &v1.SnoozeSessionRequest{Id: "s5", Until: timestamppb.New(far)}
	unsnooze := &v1.SnoozeSessionRequest{Id: "s5"}
	const working = "Snooze thread drv? Claude is still working; snoozing ends the turn."
	const waiting = "Snooze thread drv? Claude is waiting on your answer; snoozing ends the turn."

	tests := []struct {
		name       string
		ctx        command.Context
		args       map[string]string
		current    *v1.Session
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
		{name: "an idle thread snoozes without asking", ctx: command.Context{ActiveSessionID: "s5"}, args: map[string]string{"until": "2099-01-02T15:04:00Z"},
			current: idle, wantMsg: farMsg, wantReqs: []proto.Message{get, snoozeFar}},
		{name: "a duration is from now", args: map[string]string{"id": "s5", "until": "90m"},
			current: idle, wantUntil: 90 * time.Minute},
		{name: "a finished turn snoozes without asking", args: map[string]string{"id": "s5", "until": "2099-01-02T15:04:00Z"},
			current: live(v1.SessionStatus_SESSION_STATUS_NEEDS_ATTENTION, "finished"), wantMsg: farMsg},
		{name: "a disconnected thread snoozes without asking", args: map[string]string{"id": "s5", "until": "2099-01-02T15:04:00Z"},
			current: &v1.Session{Name: "drv", State: v1.SessionState_SESSION_STATE_DISCONNECTED, Status: v1.SessionStatus_SESSION_STATUS_ERROR, StatusReason: "interrupted"},
			wantMsg: farMsg},
		{name: "a working thread asks", args: map[string]string{"id": "s5", "until": "1h"}, current: busy,
			wantAsk: working, wantReqs: []proto.Message{get, get}},
		{name: "a starting thread asks", args: map[string]string{"id": "s5", "until": "tomorrow"},
			current: &v1.Session{Name: "drv", State: v1.SessionState_SESSION_STATE_STARTING}, wantAsk: working},
		{name: "a pending permission asks", args: map[string]string{"id": "s5", "until": "mon"},
			current: live(v1.SessionStatus_SESSION_STATUS_NEEDS_ATTENTION, "permission: Bash rm -rf x"), wantAsk: waiting},
		{name: "a pending question asks", args: map[string]string{"id": "s5", "until": "next-week"},
			current: live(v1.SessionStatus_SESSION_STATUS_NEEDS_ATTENTION, "question: Which one?"), wantAsk: waiting},
		{name: "background agents ask", args: map[string]string{"id": "s5", "until": "1h"},
			current: &v1.Session{Name: "drv", State: connected, Status: v1.SessionStatus_SESSION_STATUS_IDLE, BackgroundAgentsRunning: 2},
			wantAsk: "Snooze thread drv? 2 background agents are running; snoozing stops them."},
		{name: "an unnamed thread is asked about by id", args: map[string]string{"id": "s5", "until": "1h"},
			current: &v1.Session{State: connected, Status: v1.SessionStatus_SESSION_STATUS_BUSY},
			wantAsk: "Snooze thread s5? Claude is still working; snoozing ends the turn."},
		{name: "a working thread snoozes once confirmed", args: map[string]string{"id": "s5", "until": "2099-01-02T15:04:00Z"},
			current: busy, confirmed: true, wantMsg: farMsg, wantReqs: []proto.Message{snoozeFar}},
		{name: "clear unsnoozes without asking, even a working thread", args: map[string]string{"id": "s5", "clear": "true"},
			current: busy, wantMsg: "unsnoozed thread drv (s5)", wantReqs: []proto.Message{unsnooze}},
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
		{name: "unavailable without a thread", args: map[string]string{"until": "1h"}, wantErr: command.ErrUnavailable},
		{name: "an unknown thread fails in Run, not with a confirmation", args: map[string]string{"id": "s5", "until": "1h"},
			backendErr: connect.NewError(connect.CodeNotFound, errors.New("nope")), wantCode: connect.CodeNotFound},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			reg, b, _ := newSessionRegistry(t)
			b.Current, b.Err = tt.current, tt.backendErr
			before := time.Now()
			res, err := reg.Invoke(context.Background(), tt.ctx, "session.snooze", tt.args, command.Confirmed(tt.confirmed))
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
			snoozes := slices.DeleteFunc(slices.Clone(got), func(m proto.Message) bool { _, ok := m.(*v1.SnoozeSessionRequest); return !ok })
			if tt.wantAsk != "" && len(snoozes) > 0 {
				t.Error("snoozed without the confirmation")
			}
			if tt.wantUntil != 0 {
				if len(snoozes) != 1 {
					t.Fatalf("snooze requests = %v", snoozes)
				}
				until := snoozes[0].(*v1.SnoozeSessionRequest).GetUntil().AsTime()
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

func TestSessionSnoozeListsAsConfirmable(t *testing.T) {
	reg, _, _ := newSessionRegistry(t)
	c, ok := reg.Get("session.snooze")
	if !ok || c.Confirm == "" || c.Category != "Thread" {
		t.Fatalf("session.snooze = %+v", c)
	}
}
