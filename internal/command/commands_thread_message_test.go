package command_test

import (
	"context"
	"slices"
	"strings"
	"testing"

	"connectrpc.com/connect"

	"github.com/alexwaumann/code-foundry/internal/command"
	"github.com/alexwaumann/code-foundry/internal/store/thread"
)

// thread.message.cancel and thread.message.resend name the message by item id or by #N as
// thread read prints it; the daemon's refusals (internal/store/thread cancel_test.go) come
// back as the error.
func TestThreadMessageCommands(t *testing.T) {
	tests := []struct {
		name     string
		verb     string
		message  string
		wantCall string
		wantMsg  string
		wantCode connect.Code
	}{
		{name: "cancel by item id", verb: "thread.message.cancel", message: "q1", wantCall: "CancelMessage s1 q1",
			wantMsg: "cancelled #0 of thread s1; it said:\ncancelled q1"},
		{name: "cancel by #N", verb: "thread.message.cancel", message: "#1", wantCall: "CancelMessage s1 u-1"},
		{name: "cancel by N", verb: "thread.message.cancel", message: "1", wantCall: "CancelMessage s1 u-1"},
		{name: "no message #N", verb: "thread.message.cancel", message: "#9", wantCode: connect.CodeNotFound},
		{name: "already read is refused", verb: "thread.message.cancel", message: "read-1", wantCall: "CancelMessage s1 read-1", wantCode: connect.CodeFailedPrecondition},
		{name: "unknown message", verb: "thread.message.cancel", message: "x1", wantCall: "CancelMessage s1 x1", wantCode: connect.CodeNotFound},
		{name: "re-send", verb: "thread.message.resend", message: "q1", wantCall: "ResendMessage s1 q1", wantMsg: "sent again to thread s1 as #0"},
		{name: "re-send without a gone attachment", verb: "thread.message.resend", message: "gone-1", wantCall: "ResendMessage s1 gone-1",
			wantMsg: "sent again to thread s1 as #0; without a.png: no longer staged"},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			reg, fake := newThreadRegistry(t)
			if _, err := fake.Send(context.Background(), "s1", thread.Message{Text: "status?"}); err != nil {
				t.Fatal(err)
			}
			res, err := reg.Invoke(context.Background(), command.Context{}, tt.verb, map[string]string{"id": "s1", "message": tt.message})
			switch {
			case tt.wantCode != 0:
				if connect.CodeOf(err) != tt.wantCode {
					t.Fatalf("err = %v, want %v", err, tt.wantCode)
				}
			case err != nil:
				t.Fatal(err)
			}
			if tt.wantMsg != "" && res.Message != tt.wantMsg {
				t.Errorf("message %q, want %q", res.Message, tt.wantMsg)
			}
			calls := fake.Calls()
			if tt.wantCall != "" && !slices.Contains(calls, tt.wantCall) {
				t.Errorf("calls = %q, want %q", calls, tt.wantCall)
			}
			if tt.wantCall == "" && slices.ContainsFunc(calls, func(c string) bool { return strings.HasPrefix(c, "CancelMessage") }) {
				t.Errorf("calls = %q", calls)
			}
		})
	}
}
