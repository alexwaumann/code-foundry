package command_test

import (
	"context"
	"errors"
	"slices"
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
	good := `<link rel="stylesheet" href="/cf/theme.css"><script>parent.postMessage({type: "cf:resize", height: document.body.scrollHeight}, "*")</script>`
	tests := []struct {
		name      string
		uctx      command.Context
		args      map[string]string
		contents  string // the page's ("" for good)
		windows   int
		wantReq   *v1.ShowThreadHtmlRequest
		wantMsg   string
		wantPanel bool
		wantWarn  []string
		code      connect.Code
		argErr    string
	}{
		{name: "a page without the stylesheet or the resize message", uctx: inThread, args: map[string]string{"path": "/wt/docs/page.html"}, windows: 1,
			contents: "<h1 style=\"color: #333\">hi</h1>",
			wantReq:  &v1.ShowThreadHtmlRequest{ThreadId: "s-aaaaaaaaaaa1", Path: "/wt/docs/page.html"},
			wantMsg:  "shown docs/page.html in thread Usage week", wantWarn: []string{command.WarnNoThemeCSS, command.WarnNoResize}},
		{name: "a page that does not ask for its height", uctx: inThread, args: map[string]string{"path": "/wt/docs/page.html"}, windows: 1,
			contents: `<link rel="stylesheet" href="/cf/theme.css"><p>hi</p>`,
			wantReq:  &v1.ShowThreadHtmlRequest{ThreadId: "s-aaaaaaaaaaa1", Path: "/wt/docs/page.html"},
			wantMsg:  "shown docs/page.html in thread Usage week", wantWarn: []string{command.WarnNoResize}},
		{name: "a bridge page sizes itself", uctx: inThread, args: map[string]string{"path": "/wt/docs/page.html"}, windows: 1,
			contents: `<link rel="stylesheet" href="/cf/theme.css"><script src="/cf/bridge.js"></script><script type="module">await cf.ready</script>`,
			wantReq:  &v1.ShowThreadHtmlRequest{ThreadId: "s-aaaaaaaaaaa1", Path: "/wt/docs/page.html"},
			wantMsg:  "shown docs/page.html in thread Usage week"},
		{name: "a page that calls cf.run without the bridge", uctx: inThread, args: map[string]string{"path": "/wt/docs/page.html"}, windows: 1,
			contents: good + `<script>cf.run("thread.list")</script>`,
			wantReq:  &v1.ShowThreadHtmlRequest{ThreadId: "s-aaaaaaaaaaa1", Path: "/wt/docs/page.html"},
			wantMsg:  "shown docs/page.html in thread Usage week", wantWarn: []string{command.WarnNoBridge}},
		{name: "the CLI outside a thread", uctx: command.Context{}, args: map[string]string{"path": "/wt/docs/page.html"}, argErr: "thread"},
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
			contents := tt.contents
			if contents == "" {
				contents = good
			}
			files := &commandtest.Files{Files: []string{"/wt/docs/page.html", "/home/a/x.htm"}, Contents: map[string]string{"/wt/docs/page.html": contents, "/home/a/x.htm": contents}}
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
			if !slices.Equal(out.Warnings, tt.wantWarn) || !slices.Equal(res.Warnings, tt.wantWarn) {
				t.Errorf("warnings = %q (result %q), want %q", out.Warnings, res.Warnings, tt.wantWarn)
			}
			var want []*v1.UiIntent
			if tt.wantPanel {
				want = append(want, showViewWith(command.ViewPanelFile, "s-aaaaaaaaaaa1", map[string]string{"path": "/wt/docs/page.html", "project": "r1", "base": "/wt"}))
			}
			sameIntents(t, emit.Intents(), want)
		})
	}
	// In the app with no thread selected it is not available (When: hasThreadOrCLI).
	reg, _ := panelRegistry(t, &commandtest.Thread{})
	if _, err := reg.Invoke(context.Background(), command.Context{ActiveView: "projects"}, "view.inline", map[string]string{"path": "/wt/a.html"}); !errors.Is(err, command.ErrUnavailable) {
		t.Errorf("in the app outside a thread: err = %v, want ErrUnavailable", err)
	}
}
