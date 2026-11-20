package command_test

import (
	"context"
	"errors"
	"strings"
	"testing"

	"connectrpc.com/connect"

	v1 "github.com/alexwaumann/code-foundry/gen/go/codefoundry/v1"
	"github.com/alexwaumann/code-foundry/internal/command"
)

// fakeChecker answers CheckPage with res (or err) and keeps the request.
type fakeChecker struct {
	res *v1.CheckPageResponse
	err error
	got *v1.CheckPageRequest
}

func (f *fakeChecker) CheckPage(_ context.Context, req *connect.Request[v1.CheckPageRequest]) (*connect.Response[v1.CheckPageResponse], error) {
	f.got = req.Msg
	if f.err != nil {
		return nil, f.err
	}
	return connect.NewResponse(f.res), nil
}

func checkRegistry(t *testing.T, b command.PageChecker) *command.Registry {
	t.Helper()
	reg := command.NewRegistry()
	if err := command.RegisterPageCheck(reg, b); err != nil {
		t.Fatal(err)
	}
	return reg
}

// page.check passes the page, its thread and bounds to PageService.CheckPage, says what the
// render saw, and exits 1 when it found something to fix.
func TestPageCheck(t *testing.T) {
	clean := &v1.CheckPageResponse{Path: "/h/board.html", Width: 720, ThreadId: "t-1",
		Report: &v1.PageCheckReport{Loaded: true, Settled: true, SettleMs: 840, Height: 312, PageHeight: 312, Resized: true, Calls: 2}}
	broken := &v1.CheckPageResponse{Path: "/h/board.html", Width: 720, ThreadId: "t-1",
		Report: &v1.PageCheckReport{Loaded: true, Settled: true, SettleMs: 1200, Height: 420, PageHeight: 900, Problems: []*v1.PageCheckProblem{
			{Kind: "script", Message: "ReferenceError: Can't find variable: totl", Where: "board.html:42:13", Count: 1},
			{Kind: "bridge", Call: "thraed.list", Code: "unavailable", Message: "thraed.list: no command thraed.list", Count: 2},
		}}}
	cli := command.Context{Origin: command.OriginCLI, ActiveThreadID: "t-1"}
	tests := []struct {
		name     string
		ctx      command.Context
		args     map[string]string
		res      *v1.CheckPageResponse
		backErr  error
		nilBack  bool
		wantReq  *v1.CheckPageRequest
		wantMsg  []string
		wantExit int
		code     connect.Code
		argErr   string
	}{
		{name: "clean", ctx: cli, args: map[string]string{"path": "/h/board.html"}, res: clean,
			wantReq: &v1.CheckPageRequest{Path: "/h/board.html", ThreadId: "t-1", Width: 720, SettleMs: 5000},
			wantMsg: []string{"checked /h/board.html: loaded, no errors (settled in 0.8 s; 720 px wide, card 312 px tall)", "acted for thread t-1",
				"only what the page does as it loads ran"}},
		{name: "problems exit 1, each on its line", ctx: cli, args: map[string]string{"path": "/h/board.html"}, res: broken, wantExit: 1,
			wantMsg: []string{"checked /h/board.html: 3 problems (settled in 1.2 s; 720 px wide, card 420 px tall)",
				"\n- error at board.html:42:13: ReferenceError: Can't find variable: totl",
				"\n- thraed.list: unavailable: no command thraed.list (2 times)",
				"the page is 900 px tall but its card stays 420 px: load /cf/bridge.js"}},
		{name: "the shot, width and settle go to the daemon", ctx: cli,
			args:    map[string]string{"path": "/h/board.html", "shot": "/tmp/out.png", "width": "500", "settle": "2s", "thread": "t-9"},
			res:     &v1.CheckPageResponse{Path: "/h/board.html", Width: 500, Png: []byte("png"), Report: clean.GetReport()},
			wantReq: &v1.CheckPageRequest{Path: "/h/board.html", ThreadId: "t-9", Width: 500, SettleMs: 2000, Png: true},
			wantMsg: []string{"screenshot: /tmp/out.png (500 by 312 CSS px)"}},
		{name: "a shot the app could not draw says why", ctx: cli, args: map[string]string{"path": "/h/board.html", "shot": "/tmp/out.png"},
			res:     &v1.CheckPageResponse{Path: "/h/board.html", Width: 720, Report: &v1.PageCheckReport{Loaded: true, Settled: true, ShotError: "the snapshot failed"}},
			wantMsg: []string{"no screenshot: the snapshot failed"}},
		{name: "did not load", ctx: cli, args: map[string]string{"path": "/h/board.html"}, wantExit: 1,
			res:     &v1.CheckPageResponse{Path: "/h/board.html", Width: 720, Report: &v1.PageCheckReport{SettleMs: 5000}},
			wantMsg: []string{"checked /h/board.html: the page did not load in 5.0 s", "still busy when the check stopped at 5.0 s"}},
		{name: "not rendered", ctx: cli, args: map[string]string{"path": "/h/board.html"}, wantExit: 1,
			res:     &v1.CheckPageResponse{Path: "/h/board.html", Width: 720, Report: &v1.PageCheckReport{Failure: "Could not render this page: not found"}},
			wantMsg: []string{"checked /h/board.html: not rendered: Could not render this page: not found"}},
		{name: "busy at the bound", ctx: cli, args: map[string]string{"path": "/h/board.html"},
			res:     &v1.CheckPageResponse{Path: "/h/board.html", Width: 720, Report: &v1.PageCheckReport{Loaded: true, SettleMs: 5000, Busy: 1, StorageWrites: 2, Height: 420, PageHeight: 420}},
			wantMsg: []string{"still busy when the check stopped at 5.0 s: 1 call waiting", "2 cf.storage writes on load (kept in the check, not saved)"}},
		{name: "no app window: the daemon's words", ctx: cli, args: map[string]string{"path": "/h/board.html"},
			backErr: connect.NewError(connect.CodeFailedPrecondition, errors.New("no Code Foundry window is open")), code: connect.CodeFailedPrecondition},
		{name: "never from a page", ctx: command.Context{Origin: command.OriginPage, ActiveThreadID: "t-1"}, args: map[string]string{"path": "/h/board.html"},
			res: clean, code: connect.CodePermissionDenied},
		{name: "width out of bounds", ctx: cli, args: map[string]string{"path": "/h/board.html", "width": "100"}, res: clean, argErr: "width"},
		{name: "settle past the bound", ctx: cli, args: map[string]string{"path": "/h/board.html", "settle": "30s"}, res: clean, argErr: "settle"},
		{name: "no backend", ctx: cli, args: map[string]string{"path": "/h/board.html"}, nilBack: true, code: connect.CodeUnimplemented},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			f := &fakeChecker{res: tt.res, err: tt.backErr}
			var b command.PageChecker = f
			if tt.nilBack {
				b = nil
			}
			res, err := checkRegistry(t, b).Invoke(context.Background(), tt.ctx, command.PageCheckVerb, tt.args)
			if tt.code != 0 || tt.argErr != "" {
				var ae *command.ArgError
				switch {
				case tt.argErr != "" && (!errors.As(err, &ae) || ae.Arg != tt.argErr):
					t.Fatalf("err = %v, want an error on --%s", err, tt.argErr)
				case tt.code != 0 && tt.backErr == nil && connect.CodeOf(err) != tt.code:
					t.Fatalf("err = %v, want %v", err, tt.code)
				case tt.backErr != nil && (!command.IsFailed(err) || err.Error() != "no Code Foundry window is open"):
					t.Fatalf("err = %v, want the command's own failure in the daemon's words (exit 1), not a usage error", err)
				}
				if tt.backErr == nil && f.got != nil {
					t.Errorf("checked %v, want nothing asked", f.got)
				}
				return
			}
			if err != nil {
				t.Fatal(err)
			}
			if tt.wantReq != nil && f.got.String() != tt.wantReq.String() {
				t.Errorf("request = %v, want %v", f.got, tt.wantReq)
			}
			for _, w := range tt.wantMsg {
				if !strings.Contains(res.Message, w) {
					t.Errorf("message lacks %q:\n%s", w, res.Message)
				}
			}
			if res.ExitCode != tt.wantExit {
				t.Errorf("exit = %d, want %d", res.ExitCode, tt.wantExit)
			}
		})
	}
}

// A long loader error keeps its first lines and says it was cut; later lines sit under the dash.
func TestFormatPageCheckClipsAProblem(t *testing.T) {
	long := "Syntax error in board.html\n" + strings.Repeat("  12 | <div>\n", 20)
	msg := command.FormatPageCheck(&v1.CheckPageResponse{Path: "/h/b.html", Width: 720, Report: &v1.PageCheckReport{Loaded: true, Settled: true,
		Problems: []*v1.PageCheckProblem{{Kind: "loader", Message: long, Count: 1}}}}, "")
	if !strings.Contains(msg, "\n- Syntax error in board.html\n    12 | <div>") || !strings.Contains(msg, " …") || strings.Count(msg, "12 | <div>") != 7 {
		t.Errorf("message:\n%s", msg)
	}
}

// view.inline's and view.open.page's last line: the static checks' count and the next step.
func TestNextCheckLine(t *testing.T) {
	for n, want := range map[int]string{
		0: "static checks: no warnings; next: code-foundry page.check /h/p.html to see what it does when it runs",
		1: "static checks: 1 warning; next: code-foundry page.check /h/p.html to see what it does when it runs",
		3: "static checks: 3 warnings; next: code-foundry page.check /h/p.html to see what it does when it runs",
	} {
		if got := command.NextCheckLine("/h/p.html", n); got != want {
			t.Errorf("NextCheckLine(%d) = %q, want %q", n, got, want)
		}
	}
}
