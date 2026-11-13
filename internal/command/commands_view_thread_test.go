package command_test

import (
	"context"
	"errors"
	"maps"
	"strings"
	"sync"
	"testing"

	"connectrpc.com/connect"

	v1 "github.com/alexwaumann/code-foundry/gen/go/codefoundry/v1"
	"github.com/alexwaumann/code-foundry/internal/command"
	"github.com/alexwaumann/code-foundry/internal/command/all"
	"github.com/alexwaumann/code-foundry/internal/command/commandtest"
	core "github.com/alexwaumann/code-foundry/internal/layout"
	"github.com/alexwaumann/code-foundry/internal/store/layout/layouttest"
)

// retiredVerbs are the classic window's side and bottom panel verbs, gone with it
// (docs/notes/shell-22-retire-verbs.md).
var retiredVerbs = []string{"view.panel.toggle", "view.panel.expand", "view.panel.new-tab", "view.panel.split", "view.bottom.toggle"}

// richThread can show every surface: placed in a workspace and a worktree, with a
// linked pull request, a subagent run and a creator.
func richThread() *v1.Thread {
	return &v1.Thread{
		ProjectId: "r1", WorktreePath: "/wt", WorkspaceId: "w1", CreatedBy: "s-ccccccccccc3",
		LinkedPullRequests: []*v1.LinkedPullRequest{{Slug: "o/r", Number: 7}},
		AgentRuns:          []*v1.AgentRun{{Id: "a1"}},
	}
}

// panelDeps are the deps of panelRegistry beyond the thread.
type panelDeps struct {
	windows  int
	viewed   map[string]bool
	files    *commandtest.Files
	edits    command.FileEditChecker
	diffs    *commandtest.FileDiffs
	projects *commandtest.Project
	prs      *commandtest.PullRequestChecks
	layout   *layouttest.Fake
	terms    *commandtest.Terminal
}

// panelRegistry registers every command, with threads read from th and one window open.
func panelRegistry(t *testing.T, th *commandtest.Thread) (*command.Registry, *commandtest.Emitter) {
	t.Helper()
	return panelRegistryWith(t, th, panelDeps{windows: 1})
}

// layouts are the layouts of the registries panelRegistryWith made (layoutOf).
var layouts sync.Map

// layoutOf is the layout reg's item verbs open their tabs in.
func layoutOf(t *testing.T, reg *command.Registry) *layouttest.Fake {
	t.Helper()
	l, ok := layouts.Load(reg)
	if !ok {
		t.Fatal("not a registry of panelRegistryWith")
	}
	return l.(*layouttest.Fake)
}

// opened is the tab an item verb's result names, from reg's layout.
func opened(t *testing.T, reg *command.Registry, res command.Result) *core.Tab {
	t.Helper()
	var id string
	switch j := res.JSON.(type) {
	case command.PanelResult:
		id = j.Tab
	case command.PageTabResult:
		id = j.Tab
	default:
		t.Fatalf("result %+v names no tab", res.JSON)
	}
	_, _, tb := layoutOf(t, reg).Snapshot().State.FindTab(id)
	if tb == nil {
		t.Fatalf("tab %s is not in the layout", id)
	}
	return tb
}

// openedTab checks that res opened a tab of thread with params want and sent no intent. A
// wanted "askId" of "*" is any fresh request id (fileAskParams makes one per call).
func openedTab(t *testing.T, reg *command.Registry, emit *commandtest.Emitter, res command.Result, thread string, want map[string]string) *core.Tab {
	t.Helper()
	sameIntents(t, emit.Intents(), nil)
	tb := opened(t, reg, res)
	got := maps.Clone(tb.Params)
	if want["askId"] == "*" && got["askId"] != "" {
		got["askId"] = "*"
	}
	if tb.Thread != thread || !maps.Equal(got, want) {
		t.Errorf("tab of %s with %v, want one of %s with %v", tb.Thread, tb.Params, thread, want)
	}
	return tb
}

// openedNothing checks that no op reached reg's layout and no intent went out: a refusal.
func openedNothing(t *testing.T, reg *command.Registry, emit *commandtest.Emitter) {
	t.Helper()
	if ops := layoutOf(t, reg).Ops(); len(ops) != 0 {
		t.Errorf("ops = %v, want none", ops)
	}
	sameIntents(t, emit.Intents(), nil)
}

func panelRegistryWith(t *testing.T, th *commandtest.Thread, d panelDeps) (*command.Registry, *commandtest.Emitter) {
	t.Helper()
	reg := command.NewRegistry()
	emit := &commandtest.Emitter{Delivered: 1, OpenWindows: d.windows}
	deps := all.Deps{Emitter: emit, Thread: th}
	if d.viewed != nil {
		deps.Presence.Viewed = func(id string) bool { return d.viewed[id] }
	}
	if d.files != nil {
		deps.Files = d.files
	}
	if d.edits != nil {
		deps.FileEdits = d.edits
		if d.files == nil { // --edit also reads where the path leads
			deps.Files = &commandtest.Files{}
		}
	}
	if d.diffs != nil {
		deps.FileDiffs = d.diffs
	}
	if d.projects != nil {
		deps.Project = d.projects
	}
	if d.prs != nil {
		deps.PullRequestChecks.Gh = d.prs
	}
	if d.layout == nil {
		// A layout a window has loaded (the first-load import ran), as a daemon's is once the app opened.
		d.layout = layouttest.New(nil)
		d.layout.MarkImported()
	}
	deps.Layout = d.layout
	layouts.Store(reg, d.layout)
	t.Cleanup(func() { layouts.Delete(reg) })
	if d.terms != nil {
		deps.Terminal = d.terms
	}
	if err := all.Register(reg, deps); err != nil {
		t.Fatal(err)
	}
	return reg, emit
}

func showView(name string) *v1.UiIntent {
	return &v1.UiIntent{Intent: &v1.UiIntent_ShowView_{ShowView: &v1.UiIntent_ShowView{Name: name}}}
}

func sameIntents(t *testing.T, got, want []*v1.UiIntent) {
	t.Helper()
	if len(got) != len(want) {
		t.Fatalf("intents = %v, want %v", got, want)
	}
	for i := range got {
		if got[i].String() != want[i].String() {
			t.Errorf("intent %d = %v, want %v", i, got[i], want[i])
		}
	}
}

// The classic side and bottom panel verbs are gone: unknown commands, from the CLI and the app.
func TestRetiredPanelVerbs(t *testing.T) {
	reg, emit := panelRegistry(t, &commandtest.Thread{Current: richThread()})
	for _, verb := range retiredVerbs {
		if _, ok := reg.Get(verb); ok {
			t.Errorf("%s is still registered", verb)
		}
		for _, uctx := range []command.Context{{}, {ActiveThreadID: "s-aaaaaaaaaaa1"}, {ActiveThreadID: "s-aaaaaaaaaaa1", ActiveView: "thread"}} {
			if _, err := reg.Invoke(context.Background(), uctx, verb, nil); !errors.Is(err, command.ErrUnknownCommand) {
				t.Errorf("%s from %+v: err = %v, want ErrUnknownCommand", verb, uctx, err)
			}
		}
	}
	openedNothing(t, reg, emit)
}

// view.open.mcp and its alias, from the app and the CLI: the tab of the thread --thread names
// (the app's selected thread, the CLI's own), and no intent. --focus takes the user there.
func TestItemVerbThreadScope(t *testing.T) {
	gui := command.Context{ActiveThreadID: "s-aaaaaaaaaaa1", ActiveWorkspaceID: "w1", ActiveProjectID: "r1", ActiveWorktreePath: "/wt", ActiveView: "thread"}
	inThread := command.Context{ActiveThreadID: "s-aaaaaaaaaaa1"}
	tests := []struct {
		name       string
		ctx        command.Context
		args       map[string]string
		wantThread string
		wantFocus  bool
		wantMsg    string
	}{
		{name: "the app's palette: the selected thread", ctx: gui, wantThread: "s-aaaaaaaaaaa1", wantFocus: true},
		{name: "the app with an explicit --thread", ctx: gui, args: map[string]string{"thread": "s-bbbbbbbbbbb2"}, wantThread: "s-bbbbbbbbbbb2", wantFocus: true},
		{name: "the CLI in a thread acts on that thread", ctx: inThread, wantThread: "s-aaaaaaaaaaa1",
			wantMsg: "thread s-aaaaaaaaaaa1's tab is not open, so tab t-n1 opened in pane p-n1, the focused pane of its space; windows=1"},
		{name: "the CLI in a thread with --thread", ctx: inThread, args: map[string]string{"thread": "s-bbbbbbbbbbb2"}, wantThread: "s-bbbbbbbbbbb2",
			wantMsg: "thread s-bbbbbbbbbbb2's tab is not open, so tab t-n1 opened in pane p-n1, the focused pane of its space; windows=1"},
		{name: "the CLI in a thread with --focus", ctx: inThread, args: map[string]string{"focus": "true"}, wantThread: "s-aaaaaaaaaaa1", wantFocus: true,
			wantMsg: "thread s-aaaaaaaaaaa1's tab is not open, so tab t-n1 opened in pane p-n1, the focused pane of its space; it has the user's focus; windows=1"},
	}
	th := &commandtest.Thread{Current: richThread()}
	for _, verb := range []string{"view.open.mcp", "view.panel.mcp"} {
		for _, tt := range tests {
			t.Run(verb+"/"+tt.name, func(t *testing.T) {
				reg, emit := panelRegistry(t, th)
				res, err := reg.Invoke(context.Background(), tt.ctx, verb, tt.args)
				if err != nil {
					t.Fatal(err)
				}
				sameIntents(t, emit.Intents(), nil)
				if tb := opened(t, reg, res); tb.Kind != "mcp" || tb.Thread != tt.wantThread {
					t.Errorf("tab = %+v, want mcp of %s", tb, tt.wantThread)
				}
				if out := res.JSON.(command.PanelResult); out.Thread != tt.wantThread || out.TabFocused != tt.wantFocus || out.Windows != 1 {
					t.Errorf("JSON = %+v, want thread %s, focused %v, windows 1", out, tt.wantThread, tt.wantFocus)
				}
				if res.Message != tt.wantMsg {
					t.Errorf("message = %q, want %q", res.Message, tt.wantMsg)
				}
			})
		}
	}
}

// With no app window open an item verb still opens its tab (the layout keeps it for the next
// window) and says no window is open.
func TestItemVerbWithoutAWindow(t *testing.T) {
	reg, _ := panelRegistryWith(t, &commandtest.Thread{Current: richThread()}, panelDeps{windows: 0})
	res, err := reg.Invoke(context.Background(), command.Context{ActiveThreadID: "s-aaaaaaaaaaa1"}, "view.open.mcp", map[string]string{"focus": "true"})
	if err != nil {
		t.Fatal(err)
	}
	if out := res.JSON.(command.PanelResult); out.Windows != 0 || out.Tab == "" {
		t.Errorf("JSON = %+v, want a tab and no window", out)
	}
	if !strings.HasSuffix(res.Message, "; no app window is open") {
		t.Errorf("message = %q, want it to say no app window is open", res.Message)
	}
}

// An item verb reads its thread: an unknown one fails, and nothing opens then (the item
// verbs' refusals are TestPanelFile's and TestPanelDiff's).
func TestItemVerbChecksTheThread(t *testing.T) {
	notFound := &commandtest.Thread{Err: connect.NewError(connect.CodeNotFound, errors.New("no thread"))}
	reg, emit := panelRegistry(t, notFound)
	_, err := reg.Invoke(context.Background(), command.Context{ActiveThreadID: "s-aaaaaaaaaaa1"}, "view.open.mcp", map[string]string{"focus": "true"})
	if connect.CodeOf(err) != connect.CodeNotFound {
		t.Errorf("err = %v, want NotFound", err)
	}
	openedNothing(t, reg, emit)
}

// The page verbs: from a thread's CLI they refuse while no window shows that thread, unless
// --focus says the user asked. The app, the CLI outside a thread and a viewed thread are
// unchanged; with no window open nothing is taken over. The sheets (usage, settings, help) go
// to every window as a ShowView; Pull Requests and Projects are a tab of the layout, and no
// intent goes out for them.
func TestPageVerbs(t *testing.T) {
	const self = "s-aaaaaaaaaaa1"
	gui := command.Context{ActiveThreadID: self, CallerThreadID: self, ActiveView: "thread"}
	inThread := command.Context{ActiveThreadID: self, CallerThreadID: self}
	tests := []struct {
		name    string
		ctx     command.Context
		args    map[string]string
		deps    panelDeps
		wantMsg string // a sheet's; a tab's ends with its window part
		refused bool
	}{
		{name: "the app", ctx: gui, deps: panelDeps{windows: 1, viewed: map[string]bool{}}},
		{name: "the CLI outside a thread", ctx: command.Context{}, deps: panelDeps{windows: 1, viewed: map[string]bool{}}, wantMsg: "windows=1"},
		{name: "a viewed thread", ctx: inThread, deps: panelDeps{windows: 1, viewed: map[string]bool{self: true}}, wantMsg: "windows=1"},
		{name: "a thread nobody looks at", ctx: inThread, deps: panelDeps{windows: 1, viewed: map[string]bool{}}, refused: true},
		{name: "a thread nobody looks at, with --focus", ctx: inThread, args: map[string]string{"focus": "true"}, deps: panelDeps{windows: 1, viewed: map[string]bool{}}, wantMsg: "windows=1"},
		{name: "no window open", ctx: inThread, deps: panelDeps{windows: 0, viewed: map[string]bool{}}, wantMsg: command.NoWindowMessage},
		{name: "no presence", ctx: inThread, deps: panelDeps{windows: 1}, wantMsg: "windows=1"},
	}
	sheets := map[string]string{"view.usage": command.ViewUsage, "view.settings": command.ViewSettings, "view.help": command.ViewHelp}
	tabs := map[string]string{"view.pullrequests": "prs", "view.projects": "projects"}
	for _, verb := range []string{"view.usage", "view.settings", "view.help", "view.pullrequests", "view.projects"} {
		for _, tt := range tests {
			t.Run(verb+"/"+tt.name, func(t *testing.T) {
				reg, emit := panelRegistryWith(t, &commandtest.Thread{}, tt.deps)
				res, err := reg.Invoke(context.Background(), tt.ctx, verb, tt.args)
				if tt.refused {
					if connect.CodeOf(err) != connect.CodeFailedPrecondition || !strings.Contains(err.Error(), "pass --focus to take them there anyway") {
						t.Errorf("err = %v, want the refusal", err)
					}
					openedNothing(t, reg, emit)
					return
				}
				if err != nil {
					t.Fatal(err)
				}
				if kind, ok := tabs[verb]; ok {
					sameIntents(t, emit.Intents(), nil)
					if tb := opened(t, reg, res); tb.Kind != kind {
						t.Errorf("tab = %+v, want %s", tb, kind)
					}
					want := tt.wantMsg
					if want == command.NoWindowMessage {
						want = "no app window is open"
					}
					if (tt.wantMsg == "") != (res.Message == "") || !strings.HasSuffix(res.Message, want) {
						t.Errorf("message = %q, want one ending %q", res.Message, want)
					}
					return
				}
				sameIntents(t, emit.Intents(), []*v1.UiIntent{showView(sheets[verb])})
				if res.Message != tt.wantMsg {
					t.Errorf("message = %q, want %q", res.Message, tt.wantMsg)
				}
			})
		}
	}
}

// The window actions that are no page answer from the CLI too (they printed nothing).
func TestWindowActionsSayWhereTheyWent(t *testing.T) {
	for _, verb := range []string{"view.back", "view.forward", "thread.previous", "thread.next"} {
		for _, windows := range []int{0, 2} {
			reg, _ := panelRegistryWith(t, &commandtest.Thread{}, panelDeps{windows: windows})
			res, err := reg.Invoke(context.Background(), command.Context{}, verb, nil)
			if err != nil {
				t.Fatal(err)
			}
			want := command.NoWindowMessage
			if windows > 0 {
				want = "windows=2"
			}
			if res.Message != want {
				t.Errorf("%s with %d windows: message = %q, want %q", verb, windows, res.Message, want)
			}
		}
	}
}

// view.open.file: the file must exist where ReadFile reads (it decides); the tab names it
// absolute with the thread's checkout and project.
func TestPanelFile(t *testing.T) {
	inThread := command.Context{ActiveThreadID: "s-aaaaaaaaaaa1"}
	tests := []struct {
		name       string
		args       map[string]string
		files      *commandtest.Files
		wantParams map[string]string
		code       connect.Code
		argErr     string
	}{
		{name: "a file in the worktree", args: map[string]string{"path": "/wt/main.go"}, files: &commandtest.Files{Files: []string{"/wt/main.go"}},
			wantParams: map[string]string{"path": "/wt/main.go", "project": "r1", "base": "/wt"}},
		{name: "with a line", args: map[string]string{"path": "/wt/main.go", "line": "12"}, files: &commandtest.Files{Files: []string{"/wt/main.go"}},
			wantParams: map[string]string{"path": "/wt/main.go", "project": "r1", "base": "/wt", "line": "12"}},
		{name: "a file in a temp folder", args: map[string]string{"path": "/tmp/report.html"},
			files:      &commandtest.Files{Files: []string{"/tmp/report.html"}, OutsideHome: []string{"/tmp/report.html"}},
			wantParams: map[string]string{"path": "/tmp/report.html", "project": "r1", "base": "/wt"}},
		{name: "missing", args: map[string]string{"path": "/wt/nope.go"}, files: &commandtest.Files{}, code: connect.CodeNotFound},
		{name: "a directory", args: map[string]string{"path": "/wt/docs"}, files: &commandtest.Files{Dirs: []string{"/wt/docs"}}, argErr: "path"},
		{name: "line 0", args: map[string]string{"path": "/wt/main.go", "line": "0"}, files: &commandtest.Files{Files: []string{"/wt/main.go"}}, argErr: "line"},
		{name: "outside home", args: map[string]string{"path": "/etc/hosts"},
			files: &commandtest.Files{Err: connect.NewError(connect.CodeInvalidArgument, errors.New("outside the home directory"))}, code: connect.CodeInvalidArgument},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			reg, emit := panelRegistryWith(t, &commandtest.Thread{Current: richThread()}, panelDeps{windows: 1, files: tt.files})
			res, err := reg.Invoke(context.Background(), inThread, "view.panel.file", tt.args)
			if checkItemErr(t, err, tt.code, tt.argErr) {
				openedNothing(t, reg, emit)
				return
			}
			sameIntents(t, emit.Intents(), nil)
			if tb := opened(t, reg, res); tb.Kind != "file" || tb.Thread != "s-aaaaaaaaaaa1" || !maps.Equal(tb.Params, tt.wantParams) {
				t.Errorf("tab = %+v, want a file tab of s-aaaaaaaaaaa1 with %v", tb, tt.wantParams)
			}
		})
	}
}

// view.open.pr: a number the thread links names that link's repository; otherwise the
// thread's project's. The gh store must know it.
func TestPanelPR(t *testing.T) {
	inThread := command.Context{ActiveThreadID: "s-aaaaaaaaaaa1"}
	projects := &commandtest.Project{Projects: []*v1.Project{{Id: "r1", GithubSlug: "Owner/Repo"}, {Id: "r2"}}}
	ok := func() *commandtest.PullRequestChecks {
		return &commandtest.PullRequestChecks{Res: &v1.GetPullRequestResponse{PullRequest: &v1.PullRequest{}}}
	}
	tests := []struct {
		name     string
		thread   *v1.Thread
		number   string
		prs      *commandtest.PullRequestChecks
		wantSlug string
		code     connect.Code
		argErr   string
	}{
		{name: "a linked pull request", thread: richThread(), number: "7", prs: ok(), wantSlug: "o/r"},
		{name: "one in the project's repository", thread: richThread(), number: "12", prs: ok(), wantSlug: "owner/repo"},
		{name: "the store's slug wins", thread: richThread(), number: "12", wantSlug: "owner/repo-renamed",
			prs: &commandtest.PullRequestChecks{Res: &v1.GetPullRequestResponse{PullRequest: &v1.PullRequest{RepoSlug: "owner/repo-renamed"}}}},
		{name: "linked in two repositories", number: "7", prs: ok(), argErr: "number",
			thread: &v1.Thread{ProjectId: "r1", LinkedPullRequests: []*v1.LinkedPullRequest{{Slug: "o/r", Number: 7}, {Slug: "o/other", Number: 7}}}},
		{name: "a project without GitHub", thread: &v1.Thread{ProjectId: "r2"}, number: "3", prs: ok(), code: connect.CodeFailedPrecondition},
		{name: "no project", thread: &v1.Thread{}, number: "3", prs: ok(), code: connect.CodeFailedPrecondition},
		{name: "unknown to GitHub", thread: richThread(), number: "99999", code: connect.CodeNotFound,
			prs: &commandtest.PullRequestChecks{Err: connect.NewError(connect.CodeNotFound, errors.New("not found"))}},
		{name: "GitHub unreachable keeps its code", thread: richThread(), number: "12", code: connect.CodeUnavailable,
			prs: &commandtest.PullRequestChecks{Err: connect.NewError(connect.CodeUnavailable, errors.New("offline"))}},
		{name: "zero", thread: richThread(), number: "0", prs: ok(), argErr: "number"},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			reg, emit := panelRegistryWith(t, &commandtest.Thread{Current: tt.thread}, panelDeps{windows: 1, projects: projects, prs: tt.prs})
			res, err := reg.Invoke(context.Background(), inThread, "view.panel.pr", map[string]string{"number": tt.number})
			if checkItemErr(t, err, tt.code, tt.argErr) {
				openedNothing(t, reg, emit)
				return
			}
			sameIntents(t, emit.Intents(), nil)
			if tb := opened(t, reg, res); tb.Kind != "pullrequest" || !maps.Equal(tb.Params, map[string]string{"slug": tt.wantSlug, "number": tt.number}) {
				t.Errorf("tab = %+v, want pull request %s#%s", tb, tt.wantSlug, tt.number)
			}
		})
	}
}

// The item verbs always need a thread: from the CLI outside one they fail; in the app
// the selection is the thread (its context names it), and the change on screen is the
// feedback (no message).
func TestPanelItemVerbsScope(t *testing.T) {
	files := &commandtest.Files{Files: []string{"/wt/a.go"}}
	reg, emit := panelRegistryWith(t, &commandtest.Thread{Current: richThread()}, panelDeps{windows: 1, files: files})
	_, err := reg.Invoke(context.Background(), command.Context{}, "view.panel.file", map[string]string{"path": "/wt/a.go"})
	if !errors.Is(err, command.ErrUnavailable) {
		t.Errorf("outside a thread: err = %v, want ErrUnavailable", err)
	}
	gui := command.Context{ActiveThreadID: "s-aaaaaaaaaaa1", ActiveView: "thread"}
	res, err := reg.Invoke(context.Background(), gui, "view.panel.file", map[string]string{"path": "/wt/a.go"})
	if err != nil {
		t.Fatal(err)
	}
	if res.Message != "" {
		t.Errorf("message in the app = %q, want none", res.Message)
	}
	want := map[string]string{"path": "/wt/a.go", "project": "r1", "base": "/wt"}
	sameIntents(t, emit.Intents(), nil)
	if tb := opened(t, reg, res); tb.Thread != "s-aaaaaaaaaaa1" || !maps.Equal(tb.Params, want) {
		t.Errorf("tab = %+v, want %v of s-aaaaaaaaaaa1", tb, want)
	}
}

// checkItemErr checks err against a wanted connect code or ArgError, and reports
// whether one was wanted (the call failed, as it should).
func checkItemErr(t *testing.T, err error, code connect.Code, arg string) bool {
	t.Helper()
	switch {
	case arg != "":
		var argErr *command.ArgError
		if !errors.As(err, &argErr) || argErr.Arg != arg {
			t.Errorf("err = %v, want an ArgError for %s", err, arg)
		}
		return true
	case code != 0:
		if connect.CodeOf(err) != code {
			t.Errorf("err = %v, want code %v", err, code)
		}
		return true
	case err != nil:
		t.Fatal(err)
	}
	return false
}
