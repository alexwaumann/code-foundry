package api

import (
	"context"

	"connectrpc.com/connect"

	v1 "github.com/alexwaumann/code-foundry/gen/go/codefoundry/v1"
	"github.com/alexwaumann/code-foundry/internal/store/thread"
)

// ShowHtml implements ThreadService: an html item in the thread's conversation
// (code-foundry view.inline; docs/notes/inline-html.md).
func (h *Thread) ShowHtml(ctx context.Context, req *connect.Request[v1.ShowThreadHtmlRequest]) (*connect.Response[v1.ShowThreadHtmlResponse], error) {
	it, reused, err := h.store.ShowHTML(ctx, req.Msg.GetThreadId(), req.Msg.GetPath(), req.Msg.GetTitle(),
		thread.ShowHTMLOptions{Again: req.Msg.GetAgain(), Panel: req.Msg.GetPanel()})
	if err != nil {
		return nil, threadError(err)
	}
	return connect.NewResponse(&v1.ShowThreadHtmlResponse{Item: itemToProto(it), Reused: reused}), nil
}
