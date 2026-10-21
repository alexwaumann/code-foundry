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

func TestThreadReseedCommand(t *testing.T) {
	connected, disconnected := v1.ThreadState_THREAD_STATE_CONNECTED, v1.ThreadState_THREAD_STATE_DISCONNECTED
	tests := []struct {
		name     string
		ctx      command.Context
		args     map[string]string
		current  *v1.Thread
		wantErr  error
		wantMsg  string
		wantReqs []proto.Message
	}{
		{name: "a stopped thread", args: map[string]string{"id": "s-1", "system-prompt": "You are Ember.", "add-dir": "/m\n\n /n ", "prefix": "MEMORY"},
			current:  &v1.Thread{Name: "Ember", State: disconnected, Epoch: 2},
			wantMsg:  "reseeded thread Ember (s-1) (epoch 3); the next message starts the new session",
			wantReqs: []proto.Message{&v1.ReseedThreadRequest{Id: "s-1", SystemPromptAppend: "You are Ember.", AddDirs: []string{"/m", "/n"}, Prefix: "MEMORY"}}},
		{name: "an idle thread stops", ctx: command.Context{ActiveThreadID: "s-c"}, current: &v1.Thread{State: connected, Status: v1.ThreadStatus_THREAD_STATUS_IDLE},
			wantMsg:  "reseeded thread s-c (epoch 2); stopped Claude; the next message starts the new session",
			wantReqs: []proto.Message{&v1.ReseedThreadRequest{Id: "s-c"}}},
		{name: "a busy thread waits", args: map[string]string{"id": "s-1"}, current: &v1.Thread{State: connected, Status: v1.ThreadStatus_THREAD_STATUS_BUSY},
			wantMsg: "reseeded thread s-1 (epoch 2); Claude stops when its turn ends; the next message starts the new session"},
		{name: "a relative add-dir", args: map[string]string{"id": "s-1", "add-dir": "rel/dir"}, wantErr: command.ErrInvalidArgs},
		{name: "no thread", wantErr: command.ErrInvalidArgs},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			reg, b, _ := newLifecycleRegistry(t)
			b.Current = tt.current
			res, err := reg.Invoke(context.Background(), tt.ctx, "thread.reseed", tt.args)
			if tt.wantErr != nil {
				if !errors.Is(err, tt.wantErr) {
					t.Fatalf("err = %v, want %v", err, tt.wantErr)
				}
				return
			}
			if err != nil {
				t.Fatal(err)
			}
			if res.Message != tt.wantMsg {
				t.Errorf("message = %q, want %q", res.Message, tt.wantMsg)
			}
			if tt.wantReqs != nil && !slices.EqualFunc(b.Requests(), tt.wantReqs, proto.Equal) {
				t.Errorf("requests = %v, want %v", b.Requests(), tt.wantReqs)
			}
		})
	}
}

func TestThreadGetSessionLine(t *testing.T) {
	tests := []struct {
		name    string
		current *v1.Thread
		want    string // the session line; "" for none
	}{
		{name: "an ordinary thread in its first epoch", current: &v1.Thread{Epoch: 1}},
		{name: "context only", current: &v1.Thread{Epoch: 1, ContextTokens: 45210}, want: "session: context 45.2K tokens"},
		{name: "a reseeded thread", current: &v1.Thread{Epoch: 3, ReseedPending: true, SeedPending: true},
			want: "session: epoch 3, reseed pending (Claude stops when its turn ends), seed prefix waiting for the next message"},
		{name: "a resident", current: &v1.Thread{Kind: v1.ThreadKind_THREAD_KIND_RESIDENT, ResidentName: "ember", Epoch: 1, ContextTokens: 812},
			want: "session: resident ember, epoch 1, context 812 tokens"},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			reg, b, _ := newLifecycleRegistry(t)
			b.Current = tt.current
			res, err := reg.Invoke(context.Background(), command.Context{}, "thread.get", map[string]string{"id": "s-1"})
			if err != nil {
				t.Fatal(err)
			}
			var got string
			for line := range strings.SplitSeq(res.Message, "\n") {
				if strings.HasPrefix(line, "session: ") {
					got = line
				}
			}
			if got != tt.want {
				t.Errorf("session line = %q, want %q\n%s", got, tt.want, res.Message)
			}
		})
	}
}
