package command_test

import (
	"context"
	"errors"
	"slices"
	"strings"
	"testing"

	"connectrpc.com/connect"
	"google.golang.org/protobuf/proto"

	v1 "github.com/alexwaumann/code-foundry/gen/go/codefoundry/v1"
	"github.com/alexwaumann/code-foundry/internal/command"
)

func TestThreadPassUp(t *testing.T) {
	worker := &v1.Thread{Id: "s-w", Name: "Resize"}
	tests := []struct {
		name     string
		args     map[string]string
		ask      bool
		err      error
		wantErr  error
		wantCode connect.Code
		wantMsg  []string
		wantReqs []proto.Message
	}{
		{name: "a thread ask", args: map[string]string{"id": "s-w", "by": "s-lead"}, ask: true,
			wantMsg:  []string{"passed thread Resize (s-w)'s question up to the user; keep working", "goes on with its assumption", "as your message"},
			wantReqs: []proto.Message{&v1.PassUpQuestionRequest{LeadThreadId: "s-lead", WorkerId: "s-w"}}},
		{name: "a question tool's prompt, by request", args: map[string]string{"id": "s-w", "by": "s-lead", "request": "r1"},
			wantMsg:  []string{"It waits on the answer", "as if the user had answered it there"},
			wantReqs: []proto.Message{&v1.PassUpQuestionRequest{LeadThreadId: "s-lead", WorkerId: "s-w", RequestId: "r1"}}},
		{name: "the daemon's refusal is the error", args: map[string]string{"id": "s-w", "by": "s-lead"},
			err:      connect.NewError(connect.CodeFailedPrecondition, errors.New("a permission prompt: never pass one up")),
			wantCode: connect.CodeFailedPrecondition,
			wantReqs: []proto.Message{&v1.PassUpQuestionRequest{LeadThreadId: "s-lead", WorkerId: "s-w"}}},
		{name: "no worker", args: map[string]string{"by": "s-lead"}, wantErr: command.ErrInvalidArgs, wantReqs: []proto.Message{}},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			reg, b, _ := newLifecycleRegistry(t)
			b.Current, b.PassUpAsk, b.Err = worker, tt.ask, tt.err
			res, err := reg.Invoke(context.Background(), command.Context{}, "thread.pass-up", tt.args)
			switch {
			case tt.wantCode != 0:
				if connect.CodeOf(err) != tt.wantCode {
					t.Fatalf("err = %v, want code %v", err, tt.wantCode)
				}
			case tt.wantErr != nil:
				if !errors.Is(err, tt.wantErr) {
					t.Fatalf("err = %v, want %v", err, tt.wantErr)
				}
			case err != nil:
				t.Fatal(err)
			}
			for _, want := range tt.wantMsg {
				if !strings.Contains(res.Message, want) {
					t.Errorf("message %q lacks %q", res.Message, want)
				}
			}
			if got := b.Requests(); !slices.EqualFunc(got, tt.wantReqs, proto.Equal) {
				t.Errorf("requests = %v, want %v", got, tt.wantReqs)
			}
		})
	}
}

// The help says the agreed rule, in its words.
func TestThreadPassUpHelp(t *testing.T) {
	reg, _, _ := newLifecycleRegistry(t)
	c, ok := reg.Get("thread.pass-up")
	if !ok {
		t.Fatal("thread.pass-up is not registered")
	}
	if !strings.Contains(c.Description, command.PassUpRule) {
		t.Errorf("description %q", c.Description)
	}
}
