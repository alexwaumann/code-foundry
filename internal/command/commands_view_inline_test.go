package command_test

import (
	"context"
	"testing"

	"connectrpc.com/connect"

	v1 "github.com/alexwaumann/code-foundry/gen/go/codefoundry/v1"
	"github.com/alexwaumann/code-foundry/internal/command"
	"github.com/alexwaumann/code-foundry/internal/command/commandtest"
)

// view.inline: ShowHtml on the caller's thread (or --thread), "shown <path> in thread
// <name>"; --panel also opens the File tab in the thread's panel.
func TestViewInline(t *testing.T) {
	inThread := command.Context{ActiveThreadID: "s-aaaaaaaaaaa1"}
	named := richThread()
	named.Name = "Usage week"
	tests := []struct {
		name      string
		uctx      command.Context
		args      map[string]string
		windows   int
		wantReq   *v1.ShowThreadHtmlRequest
		wantMsg   string
		wantPanel bool
		code      connect.Code
		argErr    string
	}{
		{name: "the caller's thread", uctx: inThread, args: map[string]string{"path": "/wt/docs/page.html"}, windows: 1,
			wantReq: &v1.ShowThreadHtmlRequest{ThreadId: "s-aaaaaaaaaaa1", Path: "/wt/docs/page.html"},
			wantMsg: "shown docs/page.html in thread Usage week"},
		{name: "a title", uctx: inThread, args: map[string]string{"path": "/home/a/x.htm", "title": "Chart"}, windows: 1,
			wantReq: &v1.ShowThreadHtmlRequest{ThreadId: "s-aaaaaaaaaaa1", Path: "/home/a/x.htm", Title: "Chart"},
			wantMsg: "shown /home/a/x.htm in thread Usage week"},
		{name: "--panel opens the File tab too", uctx: inThread, args: map[string]string{"path": "/wt/docs/page.html", "panel": "true"}, windows: 1,
			wantReq: &v1.ShowThreadHtmlRequest{ThreadId: "s-aaaaaaaaaaa1", Path: "/wt/docs/page.html"},
			wantMsg: "shown docs/page.html in thread Usage week and in its side panel", wantPanel: true},
		{name: "--panel with no window", uctx: inThread, args: map[string]string{"path": "/wt/docs/page.html", "panel": "true"}, windows: 0,
			wantReq: &v1.ShowThreadHtmlRequest{ThreadId: "s-aaaaaaaaaaa1", Path: "/wt/docs/page.html"},
			wantMsg: "shown docs/page.html in thread Usage week (" + command.NoWindowMessage + ")", wantPanel: true},
		{name: "not html", uctx: inThread, args: map[string]string{"path": "/wt/main.go"}, code: connect.CodeInvalidArgument},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			th := &commandtest.Thread{Current: named}
			files := &commandtest.Files{Files: []string{"/wt/docs/page.html"}}
			reg, emit := panelRegistryWith(t, th, panelDeps{windows: tt.windows, files: files})
			res, err := reg.Invoke(context.Background(), tt.uctx, "view.inline", tt.args)
			if checkItemErr(t, err, tt.code, tt.argErr) {
				sameIntents(t, emit.Intents(), nil)
				return
			}
			var got *v1.ShowThreadHtmlRequest
			for _, m := range th.Requests() {
				if r, ok := m.(*v1.ShowThreadHtmlRequest); ok {
					got = r
				}
			}
			if got.String() != tt.wantReq.String() {
				t.Errorf("ShowHtml request = %v, want %v", got, tt.wantReq)
			}
			if res.Message != tt.wantMsg {
				t.Errorf("message = %q, want %q", res.Message, tt.wantMsg)
			}
			out, ok := res.JSON.(command.InlineResult)
			if !ok || out.Item != "html-1" || out.Thread != "s-aaaaaaaaaaa1" || (out.Panel != nil) != tt.wantPanel {
				t.Errorf("JSON = %+v", res.JSON)
			}
			var want []*v1.UiIntent
			if tt.wantPanel {
				want = append(want, showViewWith(command.ViewPanelFile, "s-aaaaaaaaaaa1", map[string]string{"path": "/wt/docs/page.html", "project": "r1", "base": "/wt"}))
			}
			sameIntents(t, emit.Intents(), want)
		})
	}
	// Outside a thread it is not available (When: hasThread), like the item verbs.
	reg, _ := panelRegistry(t, &commandtest.Thread{})
	if _, err := reg.Invoke(context.Background(), command.Context{}, "view.inline", map[string]string{"path": "/wt/a.html"}); err == nil {
		t.Error("outside a thread: no error")
	}
}
