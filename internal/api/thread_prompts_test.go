package api

import (
	"context"
	"slices"
	"testing"
	"time"

	"connectrpc.com/connect"

	v1 "github.com/alexwaumann/code-foundry/gen/go/codefoundry/v1"
	"github.com/alexwaumann/code-foundry/internal/bus"
	"github.com/alexwaumann/code-foundry/internal/store/thread"
	"github.com/alexwaumann/code-foundry/internal/store/thread/threadtest"
)

// ListPrompts maps the scope and the store's prompts; the store's errors map to codes.
func TestListPrompts(t *testing.T) {
	b := bus.New()
	fake := threadtest.New(b)
	fake.Put(thread.Thread{ID: "s-1"})
	at := time.UnixMilli(1_800_000_000_000)
	fake.SetPrompts(
		thread.SentPrompt{ThreadID: "s-1", ThreadName: "One", ItemID: "u2", Text: "fix it", ComposerText: "fix [a.go](cf-file://r1/a.go)", SentAt: at},
		thread.SentPrompt{ThreadID: "s-2", ThreadName: "Two", ItemID: "u1", Text: "tidy", SentAt: at.Add(-time.Minute)},
	)
	h := NewThread(fake, b)
	ctx := context.Background()

	res, err := h.ListPrompts(ctx, connect.NewRequest(&v1.ListPromptsRequest{Scope: v1.PromptScope_PROMPT_SCOPE_THREAD, ThreadId: "s-1"}))
	if err != nil {
		t.Fatal(err)
	}
	ps := res.Msg.GetPrompts()
	if len(ps) != 1 || ps[0].GetThreadId() != "s-1" || ps[0].GetThreadName() != "One" || ps[0].GetItemId() != "u2" || ps[0].GetText() != "fix it" ||
		ps[0].GetComposerText() != "fix [a.go](cf-file://r1/a.go)" || !ps[0].GetSentAt().AsTime().Equal(at) {
		t.Fatalf("prompts %v", ps)
	}
	res, err = h.ListPrompts(ctx, connect.NewRequest(&v1.ListPromptsRequest{Scope: v1.PromptScope_PROMPT_SCOPE_PROJECT, ProjectIds: []string{"r1"}, Query: "TID", Limit: 3}))
	if err != nil || len(res.Msg.GetPrompts()) != 1 || res.Msg.GetPrompts()[0].GetItemId() != "u1" {
		t.Fatalf("project = %v, %v", res, err)
	}
	if calls := fake.Calls(); !slices.Equal(calls, []string{"ListPrompts 1 s-1", "ListPrompts 2  r1"}) {
		t.Errorf("calls %q", calls)
	}

	for _, tt := range []struct {
		name string
		req  *v1.ListPromptsRequest
		code connect.Code
	}{
		{"no scope", &v1.ListPromptsRequest{ThreadId: "s-1"}, connect.CodeInvalidArgument},
		{"an unknown thread", &v1.ListPromptsRequest{Scope: v1.PromptScope_PROMPT_SCOPE_THREAD, ThreadId: "s-9"}, connect.CodeNotFound},
	} {
		if _, err := h.ListPrompts(ctx, connect.NewRequest(tt.req)); connect.CodeOf(err) != tt.code {
			t.Errorf("%s: err = %v, want %v", tt.name, err, tt.code)
		}
	}
}
