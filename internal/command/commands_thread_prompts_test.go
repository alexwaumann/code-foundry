package command_test

import (
	"context"
	"slices"
	"strings"
	"testing"
	"time"

	"google.golang.org/protobuf/proto"
	"google.golang.org/protobuf/types/known/timestamppb"

	v1 "github.com/alexwaumann/code-foundry/gen/go/codefoundry/v1"
	"github.com/alexwaumann/code-foundry/internal/command"
)

// thread.prompts picks its scope from what it is given and prints one line per prompt.
func TestThreadPrompts(t *testing.T) {
	thread := v1.PromptScope_PROMPT_SCOPE_THREAD
	projectScope := v1.PromptScope_PROMPT_SCOPE_PROJECT
	all := v1.PromptScope_PROMPT_SCOPE_ALL
	tests := []struct {
		name    string
		ctx     command.Context
		args    map[string]string
		wantReq *v1.ListPromptsRequest
		wantErr string
	}{
		{name: "inside a thread: its prompts", ctx: command.Context{ActiveThreadID: "s1"},
			wantReq: &v1.ListPromptsRequest{Scope: thread, ThreadId: "s1", Limit: 50}},
		{name: "outside a thread: every thread", wantReq: &v1.ListPromptsRequest{Scope: all, Limit: 50}},
		{name: "a thread by flag", args: map[string]string{"thread": "s1", "query": "fix", "limit": "5"},
			wantReq: &v1.ListPromptsRequest{Scope: thread, ThreadId: "s1", Query: "fix", Limit: 5}},
		{name: "project scope anchored on the thread", ctx: command.Context{ActiveThreadID: "s1"}, args: map[string]string{"scope": "project"},
			wantReq: &v1.ListPromptsRequest{Scope: projectScope, ThreadId: "s1", Limit: 50}},
		{name: "projects imply project scope and replace the anchor", ctx: command.Context{ActiveThreadID: "s1"},
			args: map[string]string{"project": "web, api"}, wantReq: &v1.ListPromptsRequest{Scope: projectScope, ProjectIds: []string{"web", "api"}, Limit: 50}},
		{name: "all ignores the thread", ctx: command.Context{ActiveThreadID: "s1"}, args: map[string]string{"scope": "all"},
			wantReq: &v1.ListPromptsRequest{Scope: all, Limit: 50}},
		{name: "thread scope without a thread", args: map[string]string{"scope": "thread"}, wantErr: "thread scope needs a thread"},
		{name: "projects outside project scope", args: map[string]string{"scope": "all", "project": "web"}, wantErr: "project is for project scope"},
		{name: "a limit over the cap", args: map[string]string{"limit": "501"}, wantErr: "limit must be 1 to 500"},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			reg, b, _ := newLifecycleRegistry(t)
			b.Current = &v1.Thread{Id: "s1"}
			res, err := reg.Invoke(context.Background(), tt.ctx, "thread.prompts", tt.args)
			if tt.wantErr != "" {
				if err == nil || !strings.Contains(err.Error(), tt.wantErr) {
					t.Fatalf("err = %v, want %q", err, tt.wantErr)
				}
				return
			}
			if err != nil {
				t.Fatal(err)
			}
			if res.Message != "no prompts" {
				t.Errorf("message %q", res.Message)
			}
			if got := b.Requests(); !slices.EqualFunc(got, []proto.Message{tt.wantReq}, proto.Equal) {
				t.Errorf("requests = %v, want %v", got, tt.wantReq)
			}
		})
	}
}

func TestFormatPrompts(t *testing.T) {
	now := time.Date(2026, 10, 28, 12, 0, 0, 0, time.UTC)
	got := command.FormatPrompts([]*v1.SentPrompt{
		{ThreadId: "s-1", ThreadName: "Fix resize race", Text: "fix the\n  resize race", SentAt: timestamppb.New(now.Add(-5 * time.Minute))},
		{ThreadId: "s-22", Text: strings.Repeat("x", 120), SentAt: timestamppb.New(now.Add(-3 * time.Hour))},
	}, now)
	want := "5m  s-1   Fix resize race  fix the resize race\n" +
		"3h  s-22  (unnamed)        " + strings.Repeat("x", 99) + "…"
	if got != want {
		t.Errorf("got:\n%s\nwant:\n%s", got, want)
	}
}
