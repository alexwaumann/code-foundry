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

func TestSessionArchive(t *testing.T) {
	connected := v1.SessionState_SESSION_STATE_CONNECTED
	live := func(status v1.SessionStatus, reason string) *v1.Session {
		return &v1.Session{Name: "drv", State: connected, Status: status, StatusReason: reason}
	}
	busy := live(v1.SessionStatus_SESSION_STATUS_BUSY, "working")
	archivedAt := timestamppb.New(time.UnixMilli(42))
	get := &v1.GetSessionRequest{Id: "s5"}
	archive := &v1.ArchiveSessionRequest{Id: "s5", Archived: true}
	unarchive := &v1.ArchiveSessionRequest{Id: "s5"}
	const working = "Archive thread drv? Claude is still working; archiving ends the turn."
	const waiting = "Archive thread drv? Claude is waiting on your answer; archiving ends the turn."

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
		wantReqs   []proto.Message
	}{
		{name: "toggle archives an idle thread without asking", ctx: command.Context{ActiveSessionID: "s5"},
			current: live(v1.SessionStatus_SESSION_STATUS_IDLE, "at prompt"),
			wantMsg: "archived thread drv (s5)", wantReqs: []proto.Message{get, get, archive}},
		{name: "a finished turn archives without asking", args: map[string]string{"id": "s5", "archived": "true"},
			current: live(v1.SessionStatus_SESSION_STATUS_NEEDS_ATTENTION, "finished"),
			wantMsg: "archived thread drv (s5)", wantReqs: []proto.Message{get, archive}},
		{name: "a failed turn archives without asking", args: map[string]string{"id": "s5", "archived": "true"},
			current: live(v1.SessionStatus_SESSION_STATUS_NEEDS_ATTENTION, "error: rate_limit"),
			wantMsg: "archived thread drv (s5)"},
		{name: "a disconnected thread archives without asking", args: map[string]string{"id": "s5", "archived": "true"},
			current: &v1.Session{Name: "drv", State: v1.SessionState_SESSION_STATE_DISCONNECTED, Status: v1.SessionStatus_SESSION_STATUS_ERROR, StatusReason: "interrupted"},
			wantMsg: "archived thread drv (s5)"},
		{name: "a closing thread archives without asking", args: map[string]string{"id": "s5", "archived": "true"},
			current: &v1.Session{Name: "drv", State: v1.SessionState_SESSION_STATE_CLOSING, Status: v1.SessionStatus_SESSION_STATUS_BUSY},
			wantMsg: "archived thread drv (s5)"},
		{name: "a working thread asks", ctx: command.Context{ActiveSessionID: "s5"}, current: busy,
			wantAsk: working, wantReqs: []proto.Message{get, get}},
		{name: "a starting thread asks", args: map[string]string{"id": "s5", "archived": "true"},
			current: &v1.Session{Name: "drv", State: v1.SessionState_SESSION_STATE_STARTING}, wantAsk: working},
		{name: "a pending permission asks", args: map[string]string{"id": "s5", "archived": "true"},
			current: live(v1.SessionStatus_SESSION_STATUS_NEEDS_ATTENTION, "permission: Bash rm -rf x"), wantAsk: waiting},
		{name: "a pending question asks", args: map[string]string{"id": "s5", "archived": "true"},
			current: live(v1.SessionStatus_SESSION_STATUS_NEEDS_ATTENTION, "question: Which one?"), wantAsk: waiting},
		{name: "an unnamed thread is asked about by id", args: map[string]string{"id": "s5", "archived": "true"},
			current: &v1.Session{State: connected, Status: v1.SessionStatus_SESSION_STATUS_BUSY},
			wantAsk: "Archive thread s5? Claude is still working; archiving ends the turn."},
		{name: "a working thread archives once confirmed", args: map[string]string{"id": "s5"}, current: busy, confirmed: true,
			wantMsg: "archived thread drv (s5)", wantReqs: []proto.Message{get, archive}},
		{name: "toggle unarchives without asking, even a working thread", args: map[string]string{"id": "s5"},
			current: &v1.Session{Name: "drv", State: connected, Status: v1.SessionStatus_SESSION_STATUS_BUSY, ArchivedAt: archivedAt},
			wantMsg: "unarchived thread drv (s5)", wantReqs: []proto.Message{get, get, unarchive}},
		{name: "explicit unarchive", args: map[string]string{"id": "s5", "archived": "false"},
			current: &v1.Session{Name: "drv", State: v1.SessionState_SESSION_STATE_DISCONNECTED, ArchivedAt: archivedAt},
			wantMsg: "unarchived thread drv (s5)", wantReqs: []proto.Message{get, unarchive}},
		{name: "re-archiving an archived thread", args: map[string]string{"id": "s5", "archived": "true"},
			current: &v1.Session{Name: "drv", State: v1.SessionState_SESSION_STATE_DISCONNECTED, ArchivedAt: archivedAt},
			wantMsg: "archived thread drv (s5)", wantReqs: []proto.Message{get, archive}},
		{name: "unavailable without a thread", wantErr: command.ErrUnavailable},
		{name: "an unknown thread fails in Run, not with a confirmation", args: map[string]string{"id": "s5", "archived": "true"},
			backendErr: connect.NewError(connect.CodeNotFound, errors.New("nope")), wantCode: connect.CodeNotFound},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			reg, b, _ := newSessionRegistry(t)
			b.Current, b.Err = tt.current, tt.backendErr
			res, err := reg.Invoke(context.Background(), tt.ctx, "session.archive", tt.args, command.Confirmed(tt.confirmed))
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
			if tt.wantAsk != "" && slices.ContainsFunc(got, func(m proto.Message) bool { _, ok := m.(*v1.ArchiveSessionRequest); return ok }) {
				t.Error("archived without the confirmation")
			}
		})
	}
}

func TestSessionArchiveListsAsConfirmable(t *testing.T) {
	reg, _, _ := newSessionRegistry(t)
	c, ok := reg.Get("session.archive")
	if !ok || c.Confirm == "" || c.Category != "Thread" {
		t.Fatalf("session.archive = %+v", c)
	}
}
