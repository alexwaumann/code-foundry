package command_test

import (
	"context"
	"errors"
	"strings"
	"testing"

	"connectrpc.com/connect"

	"github.com/alexwaumann/code-foundry/internal/api"
	"github.com/alexwaumann/code-foundry/internal/bus"
	"github.com/alexwaumann/code-foundry/internal/command"
	"github.com/alexwaumann/code-foundry/internal/store/thread"
	"github.com/alexwaumann/code-foundry/internal/store/thread/threadtest"
)

func TestThreadCompactCommand(t *testing.T) {
	refused := errors.New("thread s1 is in the middle of a turn")
	tests := []struct {
		name    string
		id      string
		fail    error
		wantMsg string
		wantErr connect.Code
		errText string
	}{
		{name: "compacts", id: "s1", wantMsg: "compacting thread s1"},
		{name: "unknown thread", id: "nope", wantErr: connect.CodeNotFound},
		{name: "a refusal reads as the store's", id: "s1", fail: errors.Join(thread.ErrFailedPrecondition, refused),
			wantErr: connect.CodeFailedPrecondition, errText: refused.Error()},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			b := bus.New()
			fake := threadtest.New(b)
			fake.Put(thread.Thread{ID: "s1", Name: "fix", State: thread.StateConnected})
			reg := command.NewRegistry()
			if err := command.RegisterThread(reg, api.NewThread(fake, b)); err != nil {
				t.Fatal(err)
			}
			if tt.fail != nil {
				fake.Err = tt.fail
			}
			res, err := reg.Invoke(context.Background(), command.Context{}, "thread.compact", map[string]string{"id": tt.id})
			if tt.wantErr != 0 {
				if connect.CodeOf(err) != tt.wantErr || !strings.Contains(err.Error(), tt.errText) {
					t.Fatalf("err = %v, want %v with %q", err, tt.wantErr, tt.errText)
				}
				return
			}
			if err != nil {
				t.Fatal(err)
			}
			if !strings.Contains(res.Message, tt.wantMsg) {
				t.Errorf("message = %q, want %q", res.Message, tt.wantMsg)
			}
			if calls := strings.Join(fake.Calls(), "\n"); !strings.Contains(calls, "Compact s1") || !strings.Contains(calls, "Send s1 /compact") {
				t.Errorf("calls = %q", calls)
			}
		})
	}
}
