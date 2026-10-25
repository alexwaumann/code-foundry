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
		shown     bool   // the page's card is still live (commandtest.Thread.PageShown)
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
		{name: "cf.* without the bridge: only the bridge warning (it sizes the card too)", uctx: inThread, args: map[string]string{"path": "/wt/docs/page.html"}, windows: 1,
			contents: `<link rel="stylesheet" href="/cf/theme.css"><script>cf.on("gh", draw)</script>`,
			wantReq:  &v1.ShowThreadHtmlRequest{ThreadId: "s-aaaaaaaaaaa1", Path: "/wt/docs/page.html"},
			wantMsg:  "shown docs/page.html in thread Usage week", wantWarn: []string{command.WarnNoBridge}},
		{name: "setInterval in a page that calls cf.run", uctx: inThread, args: map[string]string{"path": "/wt/docs/page.html"}, windows: 1,
			contents: `<link rel="stylesheet" href="/cf/theme.css"><script src="/cf/bridge.js"></script>` + `<script>async function load() { await cf.run("thread.list") } setInterval(load, 5000)</script>`,
			wantReq:  &v1.ShowThreadHtmlRequest{ThreadId: "s-aaaaaaaaaaa1", Path: "/wt/docs/page.html"},
			wantMsg:  "shown docs/page.html in thread Usage week", wantWarn: []string{command.WarnPolling}},
		{name: "a setTimeout that re-runs cf.run", uctx: inThread, args: map[string]string{"path": "/wt/docs/page.html"}, windows: 1,
			contents: `<link rel="stylesheet" href="/cf/theme.css"><script src="/cf/bridge.js"></script>` + `<script>function tick() { setTimeout(async () => { draw(await cf.run("pr.checks", {number: 4})); tick() }, 3000) }</script>`,
			wantReq:  &v1.ShowThreadHtmlRequest{ThreadId: "s-aaaaaaaaaaa1", Path: "/wt/docs/page.html"},
			wantMsg:  "shown docs/page.html in thread Usage week", wantWarn: []string{command.WarnPolling}},
		{name: "a setTimeout for a flash message is fine", uctx: inThread, args: map[string]string{"path": "/wt/docs/page.html"}, windows: 1,
			contents: `<link rel="stylesheet" href="/cf/theme.css"><script src="/cf/bridge.js"></script>` + `<script>btn.onclick = () => cf.run("thread.pin", {id}).then(() => { msg.hidden = false; setTimeout(() => { msg.hidden = true }, 2000) })</script>`,
			wantReq:  &v1.ShowThreadHtmlRequest{ThreadId: "s-aaaaaaaaaaa1", Path: "/wt/docs/page.html"},
			wantMsg:  "shown docs/page.html in thread Usage week"},
		{name: "setInterval without cf.run (a clock) is fine", uctx: inThread, args: map[string]string{"path": "/wt/docs/page.html"}, windows: 1,
			contents: `<link rel="stylesheet" href="/cf/theme.css"><script src="/cf/bridge.js"></script>` + `<script>cf.on("thread-list", draw); setInterval(() => { clock.textContent = new Date() }, 1000)</script>`,
			wantReq:  &v1.ShowThreadHtmlRequest{ThreadId: "s-aaaaaaaaaaa1", Path: "/wt/docs/page.html"},
			wantMsg:  "shown docs/page.html in thread Usage week"},
		{name: "confirm() before a merge", uctx: inThread, args: map[string]string{"path": "/wt/docs/page.html"}, windows: 1,
			contents: `<link rel="stylesheet" href="/cf/theme.css"><script src="/cf/bridge.js"></script>` + `<script>btn.onclick = () => { if (!window.confirm("Merge?")) return; cf.run("pr.merge", args) }; other.onclick = () => confirm("x")</script>`,
			wantReq:  &v1.ShowThreadHtmlRequest{ThreadId: "s-aaaaaaaaaaa1", Path: "/wt/docs/page.html"},
			wantMsg:  "shown docs/page.html in thread Usage week", wantWarn: []string{command.WarnConfirm}},
		{name: "a method called confirm is not window.confirm", uctx: inThread, args: map[string]string{"path": "/wt/docs/page.html"}, windows: 1,
			contents: `<link rel="stylesheet" href="/cf/theme.css"><script src="/cf/bridge.js"></script>` + `<script>dialog.confirm(); const requestConfirm = 1; cf.on("gh", draw)</script>`,
			wantReq:  &v1.ShowThreadHtmlRequest{ThreadId: "s-aaaaaaaaaaa1", Path: "/wt/docs/page.html"},
			wantMsg:  "shown docs/page.html in thread Usage week"},
		{name: "yes in cf.run's args", uctx: inThread, args: map[string]string{"path": "/wt/docs/page.html"}, windows: 1,
			contents: `<link rel="stylesheet" href="/cf/theme.css"><script src="/cf/bridge.js"></script>` + `<script>btn.onclick = () => cf.run("thread.archive", { id: t.id, yes: true })</script>`,
			wantReq:  &v1.ShowThreadHtmlRequest{ThreadId: "s-aaaaaaaaaaa1", Path: "/wt/docs/page.html"},
			wantMsg:  "shown docs/page.html in thread Usage week", wantWarn: []string{command.WarnReservedArg}},
		{name: "force in cf.run's args, quoted", uctx: inThread, args: map[string]string{"path": "/wt/docs/page.html"}, windows: 1,
			contents: `<link rel="stylesheet" href="/cf/theme.css"><script src="/cf/bridge.js"></script>` + `<script>btn.onclick = () => cf.run("project.cleanup", {"force": true})</script>`,
			wantReq:  &v1.ShowThreadHtmlRequest{ThreadId: "s-aaaaaaaaaaa1", Path: "/wt/docs/page.html"},
			wantMsg:  "shown docs/page.html in thread Usage week", wantWarn: []string{command.WarnReservedArg}},
		{name: "an arg named like yes is fine", uctx: inThread, args: map[string]string{"path": "/wt/docs/page.html"}, windows: 1,
			contents: `<link rel="stylesheet" href="/cf/theme.css"><script src="/cf/bridge.js"></script>` + `<script>btn.onclick = () => cf.run("thread.new", { prompt: "yes: do it", "new-worktree": true })</script>`,
			wantReq:  &v1.ShowThreadHtmlRequest{ThreadId: "s-aaaaaaaaaaa1", Path: "/wt/docs/page.html"},
			wantMsg:  "shown docs/page.html in thread Usage week"},
		{name: "a page still live: no second card", uctx: inThread, args: map[string]string{"path": "/wt/docs/page.html"}, windows: 1, shown: true,
			wantReq: &v1.ShowThreadHtmlRequest{ThreadId: "s-aaaaaaaaaaa1", Path: "/wt/docs/page.html"},
			wantMsg: "updated the page already shown in thread Usage week (docs/page.html): its card reloads after every edit, so no card was added; " +
				"run view.inline only for a new file (--again adds a second card)"},
		{name: "--again: a second card", uctx: inThread, args: map[string]string{"path": "/wt/docs/page.html", "again": "true"}, windows: 1, shown: true,
			wantReq: &v1.ShowThreadHtmlRequest{ThreadId: "s-aaaaaaaaaaa1", Path: "/wt/docs/page.html", Again: true},
			wantMsg: "shown docs/page.html in thread Usage week"},
		{name: "--panel on a page shown before: the panel only", uctx: inThread, args: map[string]string{"path": "/wt/docs/page.html", "panel": "true"}, windows: 1, shown: true,
			wantReq: &v1.ShowThreadHtmlRequest{ThreadId: "s-aaaaaaaaaaa1", Path: "/wt/docs/page.html", Panel: true},
			wantMsg: "opened docs/page.html in thread Usage week's side panel; it was shown inline before, so no card was added", wantPanel: true},
		{name: "the CLI outside a thread", uctx: command.Context{}, args: map[string]string{"path": "/wt/docs/page.html"}, argErr: "thread"},
		{name: "the caller's thread", uctx: inThread, args: map[string]string{"path": "/wt/docs/page.html"}, windows: 1,
			wantReq: &v1.ShowThreadHtmlRequest{ThreadId: "s-aaaaaaaaaaa1", Path: "/wt/docs/page.html"},
			wantMsg: "shown docs/page.html in thread Usage week"},
		{name: "a title", uctx: inThread, args: map[string]string{"path": "/home/a/x.htm", "title": "Chart"}, windows: 1,
			wantReq: &v1.ShowThreadHtmlRequest{ThreadId: "s-aaaaaaaaaaa1", Path: "/home/a/x.htm", Title: "Chart"},
			wantMsg: "shown /home/a/x.htm in thread Usage week"},
		{name: "--panel opens the File tab too", uctx: inThread, args: map[string]string{"path": "/wt/docs/page.html", "panel": "true"}, windows: 1,
			wantReq: &v1.ShowThreadHtmlRequest{ThreadId: "s-aaaaaaaaaaa1", Path: "/wt/docs/page.html", Panel: true},
			wantMsg: "shown docs/page.html in thread Usage week and in its side panel", wantPanel: true},
		{name: "--panel with no window", uctx: inThread, args: map[string]string{"path": "/wt/docs/page.html", "panel": "true"}, windows: 0,
			wantReq: &v1.ShowThreadHtmlRequest{ThreadId: "s-aaaaaaaaaaa1", Path: "/wt/docs/page.html", Panel: true},
			wantMsg: "shown docs/page.html in thread Usage week (" + command.NoWindowMessage + ")", wantPanel: true},
		{name: "not html", uctx: inThread, args: map[string]string{"path": "/wt/main.go"}, code: connect.CodeInvalidArgument},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			th := &commandtest.Thread{Current: named, PageShown: tt.shown}
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
			if !ok || out.Item != "html-1" || out.Thread != "s-aaaaaaaaaaa1" || (out.Panel != nil) != tt.wantPanel || out.Reused != (tt.shown && tt.args["again"] == "") {
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
