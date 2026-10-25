package commandtest

import (
	"context"
	"path/filepath"
	"strings"

	"connectrpc.com/connect"

	v1 "github.com/alexwaumann/code-foundry/gen/go/codefoundry/v1"
)

// ShowHtml answers an html item "html-1" holding the path relative to Current's
// worktree path when inside it; a path not ending in .html or .htm is
// INVALID_ARGUMENT, like the daemon. With PageShown it answers reused unless again.
func (s *Thread) ShowHtml(_ context.Context, r *connect.Request[v1.ShowThreadHtmlRequest]) (*connect.Response[v1.ShowThreadHtmlResponse], error) {
	if err := s.do(r.Msg); err != nil {
		return nil, err
	}
	p := r.Msg.GetPath()
	if ext := strings.ToLower(filepath.Ext(p)); ext != ".html" && ext != ".htm" {
		return nil, connect.NewError(connect.CodeInvalidArgument, nil)
	}
	base := s.current(r.Msg.GetThreadId()).GetWorktreePath()
	if rel, err := filepath.Rel(base, p); base != "" && err == nil && filepath.IsLocal(rel) {
		p = rel
	}
	return connect.NewResponse(&v1.ShowThreadHtmlResponse{Item: &v1.ThreadItem{Id: "html-1", Payload: &v1.ThreadItem_Html{
		Html: &v1.HtmlItem{Path: p, Title: r.Msg.GetTitle(), BaseDir: base}}}, Reused: s.PageShown && !r.Msg.GetAgain()}), nil
}
