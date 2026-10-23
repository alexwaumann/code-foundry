package api

import (
	"context"

	"connectrpc.com/connect"

	v1 "github.com/alexwaumann/code-foundry/gen/go/codefoundry/v1"
	"github.com/alexwaumann/code-foundry/internal/store/thread"
	"github.com/alexwaumann/code-foundry/internal/theme"
)

// ShowTheme implements ThreadService: a theme card in the thread's conversation
// (code-foundry theme save from the thread; docs/notes/theme-model-flow.md).
func (h *Thread) ShowTheme(ctx context.Context, req *connect.Request[v1.ShowThreadThemeRequest]) (*connect.Response[v1.ShowThreadThemeResponse], error) {
	t := req.Msg.GetTheme()
	card := thread.ThemeCard{File: theme.FromProto(t.GetTheme()), Applied: t.GetApplied(), Previous: t.GetPrevious(),
		PreviousVersion: t.GetPreviousVersion(), PreviousGone: t.GetPreviousGone()}
	it, err := h.store.ShowTheme(ctx, req.Msg.GetThreadId(), card)
	if err != nil {
		return nil, threadError(err)
	}
	return connect.NewResponse(&v1.ShowThreadThemeResponse{Item: itemToProto(it)}), nil
}
