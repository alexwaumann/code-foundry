package command_test

import (
	"context"
	"errors"
	"slices"
	"strings"
	"testing"

	"connectrpc.com/connect"

	"github.com/alexwaumann/code-foundry/internal/command"
	"github.com/alexwaumann/code-foundry/internal/command/commandtest"
)

// view.panel.page: view.panel.file's ShowView for an .html or .htm file, marked as the
// thread's page (page=1, the title when given), with the page's warnings but the card's
// height one; nothing is sent when the check fails.
func TestPanelPage(t *testing.T) {
	inThread := command.Context{ActiveThreadID: "s-aaaaaaaaaaa1"}
	const bridged = `<link rel="stylesheet" href="/cf/theme.css"><script src="/cf/bridge.js"></script>`
	page := func(path, contents string) *commandtest.Files {
		return &commandtest.Files{Files: []string{path}, Contents: map[string]string{path: contents}}
	}
	tests := []struct {
		name         string
		ctx          command.Context
		args         map[string]string
		files        *commandtest.Files
		noWindow     bool
		wantParams   map[string]string
		wantMsg      string
		wantWarnings []string
		code         connect.Code
		argErr       string
	}{
		{name: "a page in the worktree", args: map[string]string{"path": "/wt/welcome.html"}, files: page("/wt/welcome.html", bridged),
			wantParams: map[string]string{"path": "/wt/welcome.html", "project": "r1", "base": "/wt", "page": "1"}, wantMsg: "thread s-aaaaaaaaaaa1's tab is not open, so tab t-n1 opened in pane p-n1, the focused pane of its space; windows=1"},
		{name: "with a title", args: map[string]string{"path": "/wt/welcome.html", "title": "  Welcome "}, files: page("/wt/welcome.html", bridged),
			wantParams: map[string]string{"path": "/wt/welcome.html", "project": "r1", "base": "/wt", "page": "1", "title": "Welcome"}, wantMsg: "thread s-aaaaaaaaaaa1's tab is not open, so tab t-n1 opened in pane p-n1, the focused pane of its space; windows=1"},
		{name: "a title is plain text on one line", args: map[string]string{"path": "/wt/welcome.html", "title": "Wel\u202ecome\n  page\x07"}, files: page("/wt/welcome.html", bridged),
			wantParams: map[string]string{"path": "/wt/welcome.html", "project": "r1", "base": "/wt", "page": "1", "title": "Welcome page"}, wantMsg: "thread s-aaaaaaaaaaa1's tab is not open, so tab t-n1 opened in pane p-n1, the focused pane of its space; windows=1"},
		{name: "a title that cleans to nothing is left out", args: map[string]string{"path": "/wt/welcome.html", "title": "\u202e\n"}, files: page("/wt/welcome.html", bridged),
			wantParams: map[string]string{"path": "/wt/welcome.html", "project": "r1", "base": "/wt", "page": "1"}, wantMsg: "thread s-aaaaaaaaaaa1's tab is not open, so tab t-n1 opened in pane p-n1, the focused pane of its space; windows=1"},
		{name: "a title too long for a tab", args: map[string]string{"path": "/wt/welcome.html", "title": strings.Repeat("x", 101)}, files: page("/wt/welcome.html", bridged), argErr: "title"},
		{name: "an .HTM file", args: map[string]string{"path": "/wt/OLD.HTM"}, files: page("/wt/OLD.HTM", bridged),
			wantParams: map[string]string{"path": "/wt/OLD.HTM", "project": "r1", "base": "/wt", "page": "1"}, wantMsg: "thread s-aaaaaaaaaaa1's tab is not open, so tab t-n1 opened in pane p-n1, the focused pane of its space; windows=1"},
		{name: "in the app, no message", ctx: command.Context{ActiveThreadID: "s-aaaaaaaaaaa1", ActiveView: "thread"},
			args: map[string]string{"path": "/wt/welcome.html"}, files: page("/wt/welcome.html", bridged),
			wantParams: map[string]string{"path": "/wt/welcome.html", "project": "r1", "base": "/wt", "page": "1"}},
		{name: "no window open", args: map[string]string{"path": "/wt/welcome.html"}, files: page("/wt/welcome.html", bridged), noWindow: true,
			wantParams: map[string]string{"path": "/wt/welcome.html", "project": "r1", "base": "/wt", "page": "1"}, wantMsg: "thread s-aaaaaaaaaaa1's tab is not open, so tab t-n1 opened in pane p-n1, the focused pane of its space; no app window is open"},
		{name: "cf.* without the bridge warns", args: map[string]string{"path": "/wt/p.html"},
			files:      page("/wt/p.html", `<link rel="stylesheet" href="/cf/theme.css"><script>cf.run("thread.get")</script>`),
			wantParams: map[string]string{"path": "/wt/p.html", "project": "r1", "base": "/wt", "page": "1"}, wantMsg: "thread s-aaaaaaaaaaa1's tab is not open, so tab t-n1 opened in pane p-n1, the focused pane of its space; windows=1",
			wantWarnings: []string{command.WarnNoBridge}},
		{name: "no bridge, no card height to warn about", args: map[string]string{"path": "/wt/plain.html"}, files: page("/wt/plain.html", "<p>hi</p>"),
			wantParams: map[string]string{"path": "/wt/plain.html", "project": "r1", "base": "/wt", "page": "1"}, wantMsg: "thread s-aaaaaaaaaaa1's tab is not open, so tab t-n1 opened in pane p-n1, the focused pane of its space; windows=1"},
		{name: "not an html file", args: map[string]string{"path": "/wt/main.go"}, files: &commandtest.Files{Files: []string{"/wt/main.go"}}, argErr: "path"},
		{name: "missing", args: map[string]string{"path": "/wt/nope.html"}, files: &commandtest.Files{}, code: connect.CodeNotFound},
		{name: "a directory", args: map[string]string{"path": "/wt/site.html"}, files: &commandtest.Files{Dirs: []string{"/wt/site.html"}}, argErr: "path"},
		{name: "in a temp folder: no bridge there", args: map[string]string{"path": "/tmp/page.html"},
			files: &commandtest.Files{Files: []string{"/tmp/page.html"}, OutsideHome: []string{"/tmp/page.html"}}, argErr: "path"},
		{name: "outside home", args: map[string]string{"path": "/etc/page.html"},
			files: &commandtest.Files{Err: connect.NewError(connect.CodeInvalidArgument, errors.New("outside the home directory"))}, code: connect.CodeInvalidArgument},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			windows := 1
			if tt.noWindow {
				windows = 0
			}
			ctx := tt.ctx
			if ctx == (command.Context{}) {
				ctx = inThread
			}
			reg, emit := panelRegistryWith(t, &commandtest.Thread{Current: richThread()}, panelDeps{windows: windows, files: tt.files})
			res, err := reg.Invoke(context.Background(), ctx, "view.panel.page", tt.args)
			if checkItemErr(t, err, tt.code, tt.argErr) {
				openedNothing(t, reg, emit)
				return
			}
			openedTab(t, reg, emit, res, "s-aaaaaaaaaaa1", tt.wantParams)
			if res.Message != tt.wantMsg {
				t.Errorf("message = %q, want %q", res.Message, tt.wantMsg)
			}
			if !slices.Equal(res.Warnings, tt.wantWarnings) {
				t.Errorf("warnings = %q, want %q", res.Warnings, tt.wantWarnings)
			}
		})
	}
}

// view.panel.page needs a thread: the CLI outside one cannot run it.
func TestPanelPageNeedsAThread(t *testing.T) {
	reg, emit := panelRegistryWith(t, &commandtest.Thread{Current: richThread()}, panelDeps{windows: 1, files: &commandtest.Files{Files: []string{"/wt/p.html"}}})
	_, err := reg.Invoke(context.Background(), command.Context{}, "view.panel.page", map[string]string{"path": "/wt/p.html"})
	if !errors.Is(err, command.ErrUnavailable) {
		t.Errorf("err = %v, want ErrUnavailable", err)
	}
	sameIntents(t, emit.Intents(), nil)
}
