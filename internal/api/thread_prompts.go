package api

import (
	"context"

	"connectrpc.com/connect"
	"google.golang.org/protobuf/types/known/timestamppb"

	v1 "github.com/alexwaumann/code-foundry/gen/go/codefoundry/v1"
	"github.com/alexwaumann/code-foundry/internal/store/thread"
)

// promptScopes maps the API's prompt scopes to the store's (UNSPECIFIED is left out: the
// store refuses a zero scope).
var promptScopes = map[v1.PromptScope]thread.PromptScope{
	v1.PromptScope_PROMPT_SCOPE_THREAD:  thread.PromptScopeThread,
	v1.PromptScope_PROMPT_SCOPE_PROJECT: thread.PromptScopeProject,
	v1.PromptScope_PROMPT_SCOPE_ALL:     thread.PromptScopeAll,
}

// ListPrompts lists the prompts the user sent (docs/notes/prompt-history-1-daemon.md).
func (h *Thread) ListPrompts(ctx context.Context, req *connect.Request[v1.ListPromptsRequest]) (*connect.Response[v1.ListPromptsResponse], error) {
	m := req.Msg
	ps, err := h.store.ListPrompts(ctx, thread.PromptQuery{Scope: promptScopes[m.GetScope()], ThreadID: m.GetThreadId(),
		ProjectIDs: m.GetProjectIds(), Query: m.GetQuery(), Limit: int(m.GetLimit())})
	if err != nil {
		return nil, threadError(err)
	}
	res := &v1.ListPromptsResponse{Prompts: make([]*v1.SentPrompt, 0, len(ps))}
	for _, p := range ps {
		res.Prompts = append(res.Prompts, &v1.SentPrompt{ThreadId: p.ThreadID, ThreadName: p.ThreadName, ItemId: p.ItemID,
			Text: p.Text, SentAt: timestamppb.New(p.SentAt), ComposerText: p.ComposerText})
	}
	return connect.NewResponse(res), nil
}
